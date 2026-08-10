<?php
// One-time (or re-run anytime) historical backfill so the dashboard has
// real period-over-period data from day one instead of waiting weeks for
// fetch_daily.php to accumulate it.
//
// Usage: php cron/backfill.php --days=90

require __DIR__ . '/../vendor/autoload.php';
require __DIR__ . '/../db.php';

use Gsc\GscClient;
use Gsc\Fetch;

$opts = getopt('', ['days::']);
$days = isset($opts['days']) ? (int) $opts['days'] : 90;

$config = gsc_config();
$pdo = gsc_db();
$client = new GscClient($config['service_account_key']);

$sites = $pdo->query('SELECT id, label, gsc_site_url FROM sites')->fetchAll();

// GSC finalizes data ~3 days after the fact -- start there, not "today".
$end = new DateTime('-3 days');

for ($i = 0; $i < $days; $i++) {
    $date = (clone $end)->modify("-{$i} days")->format('Y-m-d');
    foreach ($sites as $site) {
        try {
            $count = Fetch::storeDay($pdo, $client, (int) $site['id'], $site['gsc_site_url'], $date);
            echo "[{$date}] {$site['label']}: stored {$count} rows\n";
        } catch (\Throwable $e) {
            fwrite(STDERR, "[{$date}] {$site['label']}: ERROR {$e->getMessage()}\n");
        }
    }
}
