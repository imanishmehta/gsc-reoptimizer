<?php

namespace Gsc;

use PDO;

class Fetch
{
    public static function storeDay(PDO $pdo, GscClient $client, int $siteId, string $gscSiteUrl, string $date): int
    {
        $rows = $client->fetchDay($gscSiteUrl, $date);

        $stmt = $pdo->prepare(
            'INSERT INTO stats_query_page (site_id, date, page, query, clicks, impressions, ctr, position)
             VALUES (:site_id, :date, :page, :query, :clicks, :impressions, :ctr, :position)
             ON DUPLICATE KEY UPDATE
                clicks = VALUES(clicks), impressions = VALUES(impressions),
                ctr = VALUES(ctr), position = VALUES(position)'
        );

        foreach ($rows as $row) {
            [$page, $query] = $row['keys'];
            $stmt->execute([
                'site_id' => $siteId,
                'date' => $date,
                'page' => $page,
                'query' => $query,
                'clicks' => $row['clicks'],
                'impressions' => $row['impressions'],
                'ctr' => $row['ctr'],
                'position' => $row['position'],
            ]);
        }

        return count($rows);
    }
}
