<?php
require __DIR__ . '/../vendor/autoload.php';
require __DIR__ . '/../db.php';

use Gsc\Analysis;

$pdo = gsc_db();
$analysis = new Analysis($pdo);

$sites = $pdo->query('SELECT id, label FROM sites ORDER BY label')->fetchAll();
$siteId = (int) ($_GET['site'] ?? $sites[0]['id'] ?? 0);
$days = max(7, min(365, (int) ($_GET['days'] ?? 28)));

$curEnd = new DateTime('-3 days');
$curStart = (clone $curEnd)->modify("-{$days} days");
$prevEnd = (clone $curStart)->modify('-1 day');
$prevStart = (clone $prevEnd)->modify("-{$days} days");
[$curStart, $curEnd, $prevStart, $prevEnd] = array_map(fn($d) => $d->format('Y-m-d'), [$curStart, $curEnd, $prevStart, $prevEnd]);

$headline = $siteId ? $analysis->headline($siteId, $curStart, $curEnd, $prevStart, $prevEnd) : null;
$pageDiff = $siteId ? $analysis->pageDiff($siteId, $curStart, $curEnd, $prevStart, $prevEnd) : [];
$decliners = array_slice($pageDiff, 0, 15);
$risers = array_slice(array_reverse($pageDiff), 0, 10);
$quickWins = $siteId ? $analysis->quickWins($siteId, $curStart, $curEnd) : [];
$cannibalization = $siteId ? $analysis->cannibalization($siteId, $curStart, $curEnd) : [];
$orphans = $siteId ? $analysis->orphanPages($siteId, $curStart, $curEnd) : [];

function pct(float $new, float $old): string
{
    if ($old == 0) return $new == 0 ? '0%' : '+∞%';
    $p = (($new - $old) / $old) * 100;
    return ($p >= 0 ? '+' : '') . round($p, 1) . '%';
}

function fmt_pct(float $v): string
{
    return round($v * 100, 2) . '%';
}
?>
<!doctype html>
<html>
<head>
<meta charset="utf-8">
<title>GSC Reoptimization Dashboard</title>
<link rel="stylesheet" href="style.css">
</head>
<body>
<header>
    <h1>GSC Reoptimization Dashboard</h1>
    <form method="get">
        <label>Site
            <select name="site" onchange="this.form.submit()">
                <?php foreach ($sites as $s): ?>
                <option value="<?= $s['id'] ?>" <?= $s['id'] == $siteId ? 'selected' : '' ?>><?= htmlspecialchars($s['label']) ?></option>
                <?php endforeach; ?>
            </select>
        </label>
        <label>Period
            <select name="days" onchange="this.form.submit()">
                <?php foreach ([28 => '28 days', 90 => '90 days', 365 => '365 days'] as $val => $lbl): ?>
                <option value="<?= $val ?>" <?= $val == $days ? 'selected' : '' ?>><?= $lbl ?></option>
                <?php endforeach; ?>
            </select>
        </label>
    </form>
    <p class="periods">Current: <?= $curStart ?> to <?= $curEnd ?> vs Previous: <?= $prevStart ?> to <?= $prevEnd ?></p>
</header>

<?php if ($headline): $c = $headline['current']; $p = $headline['previous']; ?>
<section class="headline">
    <div class="stat"><span><?= number_format($c['clicks']) ?></span> clicks <small><?= pct($c['clicks'], $p['clicks']) ?></small></div>
    <div class="stat"><span><?= number_format($c['impressions']) ?></span> impressions <small><?= pct($c['impressions'], $p['impressions']) ?></small></div>
    <div class="stat"><span><?= fmt_pct($c['ctr']) ?></span> CTR <small><?= pct($c['ctr'], $p['ctr']) ?></small></div>
    <div class="stat"><span><?= round($c['position'], 1) ?></span> avg position <small><?= pct($c['position'], $p['position']) ?></small></div>
</section>
<?php endif; ?>

<section>
    <h2>Top decliners</h2>
    <table>
        <tr><th>Page</th><th>Clicks</th><th>Δ Clicks</th><th>Δ Impressions</th><th>Δ Position</th></tr>
        <?php foreach ($decliners as $r): ?>
        <tr class="<?= $r['delta_clicks'] < 0 ? 'bad' : '' ?>">
            <td><a href="<?= htmlspecialchars($r['page']) ?>" target="_blank"><?= htmlspecialchars($r['page']) ?></a></td>
            <td><?= $r['clicks_old'] ?> → <?= $r['clicks_new'] ?></td>
            <td><?= $r['delta_clicks'] ?></td>
            <td><?= $r['delta_impressions'] ?></td>
            <td><?= $r['delta_position'] ?></td>
        </tr>
        <?php endforeach; ?>
    </table>
</section>

<section>
    <h2>Top risers</h2>
    <table>
        <tr><th>Page</th><th>Clicks</th><th>Δ Clicks</th><th>Δ Impressions</th><th>Δ Position</th></tr>
        <?php foreach ($risers as $r): ?>
        <tr class="good">
            <td><a href="<?= htmlspecialchars($r['page']) ?>" target="_blank"><?= htmlspecialchars($r['page']) ?></a></td>
            <td><?= $r['clicks_old'] ?> → <?= $r['clicks_new'] ?></td>
            <td>+<?= $r['delta_clicks'] ?></td>
            <td><?= $r['delta_impressions'] ?></td>
            <td><?= $r['delta_position'] ?></td>
        </tr>
        <?php endforeach; ?>
    </table>
</section>

<section>
    <h2>Quick wins <small>(striking distance: position 4-15, low CTR)</small></h2>
    <table>
        <tr><th>Query</th><th>Page</th><th>Position</th><th>CTR</th><th>Impressions</th></tr>
        <?php foreach ($quickWins as $r): ?>
        <tr>
            <td><?= htmlspecialchars($r['query']) ?></td>
            <td><a href="<?= htmlspecialchars($r['page']) ?>" target="_blank"><?= htmlspecialchars(parse_url($r['page'], PHP_URL_PATH) ?: $r['page']) ?></a></td>
            <td><?= round($r['position'], 1) ?></td>
            <td><?= fmt_pct($r['ctr']) ?></td>
            <td><?= (int) $r['impressions'] ?></td>
        </tr>
        <?php endforeach; ?>
    </table>
</section>

<section>
    <h2>Keyword map <small>(top decliners -- primary/secondary keywords per page)</small></h2>
    <?php foreach (array_slice($decliners, 0, 8) as $r): ?>
        <?php $kw = $analysis->keywordsForPage($siteId, $r['page'], $curStart, $curEnd, 6); ?>
        <?php if (!$kw) continue; ?>
        <h3><?= htmlspecialchars($r['page']) ?></h3>
        <table>
            <tr><th>Query</th><th>Clicks</th><th>Impressions</th><th>Position</th></tr>
            <?php foreach ($kw as $i => $k): ?>
            <tr class="<?= $i === 0 ? 'primary' : '' ?>">
                <td><?= htmlspecialchars($k['query']) ?><?= $i === 0 ? ' <strong>(primary)</strong>' : '' ?></td>
                <td><?= (int) $k['clicks'] ?></td>
                <td><?= (int) $k['impressions'] ?></td>
                <td><?= round($k['position'], 1) ?></td>
            </tr>
            <?php endforeach; ?>
        </table>
    <?php endforeach; ?>
</section>

<section>
    <h2>Cannibalization <small>(same query, multiple pages competing)</small></h2>
    <table>
        <tr><th>Query</th><th>Competing pages</th></tr>
        <?php foreach ($cannibalization as $query => $pages): ?>
        <tr>
            <td><?= htmlspecialchars($query) ?></td>
            <td><?php foreach ($pages as $p): ?>
                <div><?= htmlspecialchars(parse_url($p['page'], PHP_URL_PATH) ?: $p['page']) ?> (<?= (int) $p['impressions'] ?> impr, pos <?= round($p['position'], 1) ?>)</div>
            <?php endforeach; ?></td>
        </tr>
        <?php endforeach; ?>
    </table>
</section>

<section>
    <h2>Coverage gaps <small>(sitemap URLs with ~zero impressions -- orphan/indexing proxy)</small></h2>
    <p>Spot-check these with <a href="inspect.php?site=<?= $siteId ?>">the inspector</a> before assuming they're deindexed -- could just be new or genuinely low-demand.</p>
    <ul>
        <?php foreach ($orphans as $url): ?>
        <li><a href="<?= htmlspecialchars($url) ?>" target="_blank"><?= htmlspecialchars($url) ?></a></li>
        <?php endforeach; ?>
    </ul>
</section>

</body>
</html>
