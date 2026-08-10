<?php
// On-demand URL Inspection -- not cron'd, GSC rate-limits this API tightly.
require __DIR__ . '/../vendor/autoload.php';
require __DIR__ . '/../db.php';

use Gsc\GscClient;

$pdo = gsc_db();
$config = gsc_config();

$siteId = (int) ($_GET['site'] ?? 0);
$site = $pdo->prepare('SELECT * FROM sites WHERE id = ?');
$site->execute([$siteId]);
$site = $site->fetch();

$result = null;
$error = null;
if ($site && !empty($_POST['url'])) {
    try {
        $client = new GscClient($config['service_account_key']);
        $result = $client->inspectUrl($site['gsc_site_url'], $_POST['url']);
        $pdo->prepare(
            'INSERT INTO index_inspections (site_id, url, verdict, coverage_state, checked_at)
             VALUES (:site_id, :url, :verdict, :coverage, NOW())
             ON DUPLICATE KEY UPDATE verdict = VALUES(verdict), coverage_state = VALUES(coverage_state), checked_at = NOW()'
        )->execute([
            'site_id' => $siteId, 'url' => $_POST['url'],
            'verdict' => $result['verdict'], 'coverage' => $result['coverageState'],
        ]);
    } catch (\Throwable $e) {
        $error = $e->getMessage();
    }
}

$history = $pdo->prepare('SELECT * FROM index_inspections WHERE site_id = ? ORDER BY checked_at DESC LIMIT 30');
$history->execute([$siteId]);
?>
<!doctype html>
<html>
<head><meta charset="utf-8"><title>URL Inspector</title><link rel="stylesheet" href="style.css"></head>
<body>
<h1>URL Inspector -- <?= htmlspecialchars($site['label'] ?? '') ?></h1>
<form method="post">
    <input type="url" name="url" placeholder="https://..." required style="width:400px">
    <input type="hidden" name="site" value="<?= $siteId ?>">
    <button type="submit">Inspect</button>
</form>
<?php if ($error): ?><p class="bad">Error: <?= htmlspecialchars($error) ?></p><?php endif; ?>
<?php if ($result): ?>
<p><strong>Verdict:</strong> <?= htmlspecialchars($result['verdict']) ?> -- <strong>Coverage:</strong> <?= htmlspecialchars($result['coverageState']) ?></p>
<?php endif; ?>
<h2>Recent checks</h2>
<table>
<tr><th>URL</th><th>Verdict</th><th>Coverage</th><th>Checked</th></tr>
<?php foreach ($history->fetchAll() as $h): ?>
<tr><td><?= htmlspecialchars($h['url']) ?></td><td><?= htmlspecialchars($h['verdict']) ?></td><td><?= htmlspecialchars($h['coverage_state']) ?></td><td><?= $h['checked_at'] ?></td></tr>
<?php endforeach; ?>
</table>
<p><a href="index.php?site=<?= $siteId ?>">Back to dashboard</a></p>
</body>
</html>
