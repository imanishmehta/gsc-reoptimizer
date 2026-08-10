<?php

namespace Gsc;

use PDO;

class Analysis
{
    public function __construct(private PDO $pdo)
    {
    }

    private function periodSums(int $siteId, string $groupBy, string $start, string $end): array
    {
        // groupBy is either 'page' or 'query' -- never user input, safe to interpolate
        $sql = "SELECT {$groupBy} AS k,
                    SUM(clicks) AS clicks,
                    SUM(impressions) AS impressions,
                    CASE WHEN SUM(impressions) > 0 THEN SUM(clicks) / SUM(impressions) ELSE 0 END AS ctr,
                    CASE WHEN SUM(impressions) > 0 THEN SUM(position * impressions) / SUM(impressions) ELSE 0 END AS position
                FROM stats_query_page
                WHERE site_id = :site_id AND date BETWEEN :start AND :end
                GROUP BY {$groupBy}";
        $stmt = $this->pdo->prepare($sql);
        $stmt->execute(['site_id' => $siteId, 'start' => $start, 'end' => $end]);
        $out = [];
        foreach ($stmt->fetchAll() as $row) {
            $out[$row['k']] = $row;
        }
        return $out;
    }

    public function headline(int $siteId, string $curStart, string $curEnd, string $prevStart, string $prevEnd): array
    {
        $cur = $this->totals($siteId, $curStart, $curEnd);
        $prev = $this->totals($siteId, $prevStart, $prevEnd);
        return ['current' => $cur, 'previous' => $prev];
    }

    private function totals(int $siteId, string $start, string $end): array
    {
        // aggregate page-level first (periodSums groups by page), then sum --
        // summing raw rows here would double-count impressions across queries per page
        $pages = $this->periodSums($siteId, 'page', $start, $end);
        $clicks = array_sum(array_column($pages, 'clicks'));
        $impressions = array_sum(array_column($pages, 'impressions'));
        $posWeighted = 0;
        foreach ($pages as $p) {
            $posWeighted += $p['position'] * $p['impressions'];
        }
        return [
            'clicks' => (int) $clicks,
            'impressions' => (int) $impressions,
            'ctr' => $impressions > 0 ? $clicks / $impressions : 0,
            'position' => $impressions > 0 ? $posWeighted / $impressions : 0,
        ];
    }

    /** @return array sorted by click delta ascending (worst decliners first) */
    public function pageDiff(int $siteId, string $curStart, string $curEnd, string $prevStart, string $prevEnd): array
    {
        $cur = $this->periodSums($siteId, 'page', $curStart, $curEnd);
        $prev = $this->periodSums($siteId, 'page', $prevStart, $prevEnd);
        $keys = array_unique(array_merge(array_keys($cur), array_keys($prev)));

        $rows = [];
        foreach ($keys as $page) {
            $c = $cur[$page] ?? ['clicks' => 0, 'impressions' => 0, 'ctr' => 0, 'position' => 0];
            $p = $prev[$page] ?? ['clicks' => 0, 'impressions' => 0, 'ctr' => 0, 'position' => 0];
            $rows[] = [
                'page' => $page,
                'clicks_new' => (int) $c['clicks'], 'clicks_old' => (int) $p['clicks'],
                'delta_clicks' => (int) $c['clicks'] - (int) $p['clicks'],
                'impressions_new' => (int) $c['impressions'], 'impressions_old' => (int) $p['impressions'],
                'delta_impressions' => (int) $c['impressions'] - (int) $p['impressions'],
                'ctr_new' => round($c['ctr'], 4), 'ctr_old' => round($p['ctr'], 4),
                'position_new' => round($c['position'], 1), 'position_old' => round($p['position'], 1),
                'delta_position' => round($c['position'] - $p['position'], 1),
            ];
        }
        usort($rows, fn($a, $b) => $a['delta_clicks'] <=> $b['delta_clicks']);
        return $rows;
    }

    /** Striking-distance quick wins: decent impressions, position 4-15, low CTR. */
    public function quickWins(int $siteId, string $start, string $end, int $minImpressions = 50, float $maxCtr = 0.02, float $posMin = 4, float $posMax = 15): array
    {
        $stmt = $this->pdo->prepare(
            'SELECT query, page, SUM(clicks) AS clicks, SUM(impressions) AS impressions,
                CASE WHEN SUM(impressions) > 0 THEN SUM(clicks) / SUM(impressions) ELSE 0 END AS ctr,
                CASE WHEN SUM(impressions) > 0 THEN SUM(position * impressions) / SUM(impressions) ELSE 0 END AS position
             FROM stats_query_page
             WHERE site_id = :site_id AND date BETWEEN :start AND :end
             GROUP BY query, page
             HAVING impressions >= :min_impr AND ctr <= :max_ctr AND position BETWEEN :pos_min AND :pos_max
             ORDER BY impressions DESC
             LIMIT 50'
        );
        $stmt->execute([
            'site_id' => $siteId, 'start' => $start, 'end' => $end,
            'min_impr' => $minImpressions, 'max_ctr' => $maxCtr, 'pos_min' => $posMin, 'pos_max' => $posMax,
        ]);
        return $stmt->fetchAll();
    }

    /** Top queries for one page -- used to infer primary/secondary keywords. */
    public function keywordsForPage(int $siteId, string $page, string $start, string $end, int $limit = 10): array
    {
        $stmt = $this->pdo->prepare(
            'SELECT query, SUM(clicks) AS clicks, SUM(impressions) AS impressions,
                CASE WHEN SUM(impressions) > 0 THEN SUM(clicks) / SUM(impressions) ELSE 0 END AS ctr,
                CASE WHEN SUM(impressions) > 0 THEN SUM(position * impressions) / SUM(impressions) ELSE 0 END AS position
             FROM stats_query_page
             WHERE site_id = :site_id AND page = :page AND date BETWEEN :start AND :end
             GROUP BY query
             ORDER BY clicks DESC, impressions DESC
             LIMIT :limit'
        );
        $stmt->bindValue('site_id', $siteId, PDO::PARAM_INT);
        $stmt->bindValue('page', $page);
        $stmt->bindValue('start', $start);
        $stmt->bindValue('end', $end);
        $stmt->bindValue('limit', $limit, PDO::PARAM_INT);
        $stmt->execute();
        return $stmt->fetchAll();
    }

    /** Queries where 2+ pages compete for the same query -- cannibalization. */
    public function cannibalization(int $siteId, string $start, string $end, int $minImpressions = 20): array
    {
        $stmt = $this->pdo->prepare(
            'SELECT query, page, SUM(clicks) AS clicks, SUM(impressions) AS impressions,
                CASE WHEN SUM(impressions) > 0 THEN SUM(position * impressions) / SUM(impressions) ELSE 0 END AS position
             FROM stats_query_page
             WHERE site_id = :site_id AND date BETWEEN :start AND :end
             GROUP BY query, page
             HAVING impressions >= :min_impr
             ORDER BY query, impressions DESC'
        );
        $stmt->execute(['site_id' => $siteId, 'start' => $start, 'end' => $end, 'min_impr' => $minImpressions]);
        $byQuery = [];
        foreach ($stmt->fetchAll() as $row) {
            $byQuery[$row['query']][] = $row;
        }
        return array_filter($byQuery, fn($pages) => count($pages) > 1);
    }

    /** Sitemap URLs with ~zero GSC impressions in the period -- orphan/coverage proxy. */
    public function orphanPages(int $siteId, string $start, string $end): array
    {
        $stmt = $this->pdo->prepare(
            "SELECT su.url
             FROM sitemap_urls su
             LEFT JOIN (
                 SELECT page, SUM(impressions) AS impressions
                 FROM stats_query_page
                 WHERE site_id = :site_id AND date BETWEEN :start AND :end
                 GROUP BY page
             ) sp ON su.url = sp.page
             WHERE su.site_id = :site_id2 AND COALESCE(sp.impressions, 0) = 0
             ORDER BY su.url"
        );
        $stmt->execute(['site_id' => $siteId, 'start' => $start, 'end' => $end, 'site_id2' => $siteId]);
        return array_column($stmt->fetchAll(), 'url');
    }
}
