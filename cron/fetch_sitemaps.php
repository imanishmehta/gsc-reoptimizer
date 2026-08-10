<?php
// Run weekly via cron. Plain HTTP fetch of the public sitemap.xml -- no GSC
// API needed for this part. Feeds the orphan/coverage-gap check on the
// dashboard (sitemap URLs with ~zero GSC impressions).
//
// crontab: 0 5 * * 1 php /path/to/cron/fetch_sitemaps.php >> /path/to/logs/sitemaps.log 2>&1

require __DIR__ . '/../db.php';

function fetch_sitemap_urls(string $url, int $depth = 0): array
{
    if ($depth > 3) {
        return []; // guard against a misconfigured sitemap index looping into itself
    }

    $xml = @simplexml_load_string(file_get_contents($url));
    if ($xml === false) {
        fwrite(STDERR, "Failed to parse sitemap: {$url}\n");
        return [];
    }

    $urls = [];
    if (isset($xml->sitemap)) {
        // sitemap index -- recurse into each child sitemap
        foreach ($xml->sitemap as $entry) {
            $urls = array_merge($urls, fetch_sitemap_urls((string) $entry->loc, $depth + 1));
        }
    } elseif (isset($xml->url)) {
        foreach ($xml->url as $entry) {
            $urls[] = (string) $entry->loc;
        }
    }
    return $urls;
}

$pdo = gsc_db();
$today = (new DateTime())->format('Y-m-d');

$sites = $pdo->query('SELECT id, label, sitemap_url FROM sites')->fetchAll();
$stmt = $pdo->prepare(
    'INSERT INTO sitemap_urls (site_id, url, last_seen) VALUES (:site_id, :url, :today)
     ON DUPLICATE KEY UPDATE last_seen = VALUES(last_seen)'
);

foreach ($sites as $site) {
    $urls = fetch_sitemap_urls($site['sitemap_url']);
    foreach ($urls as $url) {
        $stmt->execute(['site_id' => $site['id'], 'url' => $url, 'today' => $today]);
    }
    $sample = $urls[0] ?? 'n/a';
    echo "{$site['label']}: {$sample}... " . count($urls) . " URLs\n";
}
