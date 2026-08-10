<?php
// Run daily via cron. GSC finalizes data ~2-3 days after the fact, so this
// pulls a single day, 3 days back, each run -- catching it right after it
// settles without re-pulling a wide window every time.
//
// crontab: 0 6 * * * php /path/to/cron/fetch_daily.php >> /path/to/logs/fetch.log 2>&1

require __DIR__ . '/../vendor/autoload.php';
require __DIR__ . '/../db.php';

use Gsc\GscClient;
use Gsc\Fetch;

$config = gsc_config();
$pdo = gsc_db();
$client = new GscClient($config['service_account_key']);

$date = (new DateTime('-3 days'))->format('Y-m-d');

$sites = $pdo->query('SELECT id, label, gsc_site_url FROM sites')->fetchAll();
foreach ($sites as $site) {
    try {
        $count = Fetch::storeDay($pdo, $client, (int) $site['id'], $site['gsc_site_url'], $date);
        echo "[{$date}] {$site['label']}: stored {$count} rows\n";
    } catch (\Throwable $e) {
        fwrite(STDERR, "[{$date}] {$site['label']}: ERROR {$e->getMessage()}\n");
    }
}
