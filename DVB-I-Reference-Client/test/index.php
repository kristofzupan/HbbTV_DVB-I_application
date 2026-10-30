<?php
/**
 * Control page for user tests: start the next participant's session (which
 * also restarts every stream and resets the television), and download the
 * session logs as CSV.
 */
require __DIR__ . '/common.php';

// Opened as /test rather than /test/, every relative link on this page —
// reset.php, report.php — resolves against the parent directory and misses.
// nginx adds the slash itself; PHP's development server does not.
$path = parse_url($_SERVER['REQUEST_URI'] ?? '', PHP_URL_PATH);
if ($path !== null && substr($path, -1) !== '/' && basename($path) !== 'index.php') {
    $query = $_SERVER['QUERY_STRING'] ?? '';
    header('Location: ' . $path . '/' . ($query !== '' ? '?' . $query : ''), true, 301);
    exit;
}

start_login_session();
no_cache();

if (isset($_POST['login'])) {
    $ok = hash_equals(ADMIN_USER, (string) ($_POST['user'] ?? ''))
        && hash_equals(ADMIN_PASSWORD, (string) ($_POST['password'] ?? ''));
    if ($ok) {
        session_regenerate_id(true);
        $_SESSION['test_admin'] = true;
    }
    header('Location: index.php' . ($ok ? '' : '?error=login'));
    exit;
}
if (isset($_GET['logout'])) {
    $_SESSION = [];
    session_destroy();
    header('Location: index.php');
    exit;
}

/** Last event received in a session, read from the end of its log. */
function last_event($id)
{
    $file = session_file($id);
    $size = @filesize($file);
    if (!$size) return null;
    $fh = fopen($file, 'r');
    fseek($fh, max(0, $size - 4096));
    $lines = array_filter(explode("\n", fread($fh, 4096)));
    fclose($fh);
    return json_decode(end($lines), true);
}

function count_events($id)
{
    $file = session_file($id);
    if (!is_file($file)) return 0;
    $n = 0;
    $fh = fopen($file, 'r');
    while (fgets($fh) !== false) $n++;
    fclose($fh);
    return $n;
}

// Polled by this page, so you can see the television pick up a reset without
// walking over to it.
if (isset($_GET['status'])) {
    require_login();
    header('Content-Type: application/json');
    $state = current_state();
    $last = $state['session'] !== '' ? last_event($state['session']) : null;
    echo json_encode([
        'session' => $state['session'],
        'lastReceived' => $last['received'] ?? null,
        'lastAction' => $last['action'] ?? null,
        'now' => (int) round(microtime(true) * 1000),
    ]);
    exit;
}

$logged_in = is_logged_in();
$state = current_state();
$index = array_reverse(sessions_index());
$h = function ($s) {
    return htmlspecialchars((string) $s, ENT_QUOTES, 'UTF-8');
};
?>
<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Test sessions</title>
<style>
  :root { --bg: #f6f6f4; --fg: #1d1d1b; --muted: #6b6b66; --card: #fff; --line: #deded9; --accent: #1f5fbf; --ok: #2e7d32; --warn: #b26a00; }
  @media (prefers-color-scheme: dark) {
    :root { --bg: #161615; --fg: #ececea; --muted: #9a9a94; --card: #20201e; --line: #34342f; --accent: #6ea2ff; --ok: #7bc47f; --warn: #f0b04a; }
  }
  * { box-sizing: border-box; }
  body { margin: 0; background: var(--bg); color: var(--fg); font: 16px/1.45 system-ui, sans-serif; }
  main { max-width: 860px; margin: 0 auto; padding: 24px 16px 48px; }
  h1 { font-size: 1.4rem; margin: 0 0 16px; }
  h2 { font-size: 1.05rem; margin: 0 0 12px; }
  .card { background: var(--card); border: 1px solid var(--line); border-radius: 10px; padding: 18px; margin-bottom: 16px; }
  label { display: block; font-size: .85rem; color: var(--muted); margin-bottom: 4px; }
  input { font: inherit; padding: 9px 11px; border: 1px solid var(--line); border-radius: 7px; background: var(--bg); color: var(--fg); width: 100%; }
  button, .btn { font: inherit; font-weight: 600; padding: 10px 16px; border-radius: 7px; border: 0; background: var(--accent); color: #fff; cursor: pointer; text-decoration: none; display: inline-block; }
  button.secondary { background: transparent; color: var(--accent); border: 1px solid var(--accent); }
  .row form { margin: 0; }
  .row { display: flex; gap: 10px; align-items: end; flex-wrap: wrap; }
  .row > div { flex: 1 1 200px; }
  .muted { color: var(--muted); font-size: .9rem; }
  .err { color: #c62828; margin: 0 0 12px; }
  .current { font-size: 1.15rem; font-weight: 600; }
  #tv.ok { color: var(--ok); } #tv.warn { color: var(--warn); }
  table { width: 100%; border-collapse: collapse; font-size: .92rem; }
  th, td { text-align: left; padding: 8px 6px; border-bottom: 1px solid var(--line); }
  th { color: var(--muted); font-weight: 500; }
  td a { color: var(--accent); }
  details summary { cursor: pointer; }
  details td { vertical-align: top; }
  details td:first-child { width: 38%; }
  code { font-size: .85em; }
  .table-wrap { overflow-x: auto; }
  .top { display: flex; justify-content: space-between; align-items: baseline; }
  .top a { color: var(--muted); font-size: .9rem; }
</style>
</head>
<body>
<main>
<?php if (!$logged_in): ?>
  <h1>Test sessions</h1>
  <form class="card" method="post" style="max-width: 360px">
    <?php if (($_GET['error'] ?? '') === 'login'): ?><p class="err">Wrong username or password.</p><?php endif; ?>
    <label for="user">Username</label>
    <input id="user" name="user" autocomplete="username" autofocus>
    <label for="password" style="margin-top: 10px">Password</label>
    <input id="password" name="password" type="password" autocomplete="current-password">
    <p><button name="login" value="1">Log in</button></p>
  </form>
<?php else: ?>
  <div class="top"><h1>Test sessions</h1><a href="?logout=1">Log out</a></div>

  <section class="card">
    <h2>Current session</h2>
    <?php if ($state['session'] === ''): ?>
      <p class="muted">No session running. Anything done on the television now goes to the unassigned log, not into anyone's results.</p>
    <?php else: ?>
      <p class="current"><?= $h($state['participant']) ?> <span class="muted">(<?= $h($state['session']) ?>)</span></p>
      <p id="tv" class="muted">Television: waiting for first report…</p>
    <?php endif; ?>
    <div class="row" style="margin-top: 14px">
      <form method="post" action="reset.php"
            onsubmit="return confirm('Restart all streams from the beginning?\n\nThe television reloads on channel 1. The session<?= $state['session'] === '' ? '' : ' (' . $h($state['participant']) . ')' ?> is not changed.');">
        <input type="hidden" name="action" value="restart">
        <button class="secondary">Restart streams</button>
      </form>
      <?php if ($state['session'] !== ''): ?>
      <form method="post" action="reset.php"
            onsubmit="return confirm('End the session for <?= $h($state['participant']) ?>?\n\nNothing restarts. From now on the television is not recorded into this participant\'s results.');">
        <input type="hidden" name="action" value="end">
        <button class="secondary">End session</button>
      </form>
      <?php endif; ?>
    </div>
  </section>

  <form class="card" method="post" action="reset.php"
        onsubmit="return confirm('Start a new session for ' + this.participant.value + '?\n\nAll streams restart from the beginning and the television reloads on channel 1.');">
    <input type="hidden" name="action" value="start">
    <h2>Next participant</h2>
    <?php if (($_GET['error'] ?? '') === 'participant'): ?><p class="err">Enter a participant code (letters, digits, - and _).</p><?php endif; ?>
    <div class="row">
      <div>
        <label for="participant">Participant code</label>
        <input id="participant" name="participant" placeholder="e.g. P07" pattern="[A-Za-z0-9_\-]+" required>
      </div>
      <button>Start session</button>
    </div>
    <p class="muted">Ends the running session, restarts every channel from the start of its loop and reloads the television on channel 1, with the application in its default state.</p>
  </form>

  <section class="card">
    <div class="top">
      <h2>Sessions</h2>
      <?php if ($index): ?>
        <span><a href="report.php?type=summary&amp;session=all">Summary CSV (all)</a> · <a href="report.php?type=events&amp;session=all">Events CSV (all)</a></span>
      <?php endif; ?>
    </div>
    <?php if (!$index): ?>
      <p class="muted">No sessions yet.</p>
    <?php else: ?>
    <div class="table-wrap">
      <table>
        <tr><th>Participant</th><th>Started</th><th>Ended</th><th>Events</th><th>Download</th></tr>
        <?php foreach ($index as $s): ?>
        <tr>
          <td><?= $h($s['participant']) ?></td>
          <td><?= $h(date('Y-m-d H:i', (int) ($s['startedAt'] / 1000))) ?></td>
          <td><?= !empty($s['endedAt']) ? $h(date('H:i', (int) ($s['endedAt'] / 1000))) : ($s['id'] === $state['session'] ? '<strong>running</strong>' : '') ?></td>
          <td><?= count_events($s['id']) ?></td>
          <td>
            <a href="report.php?type=summary&amp;session=<?= urlencode($s['id']) ?>">summary</a> ·
            <a href="report.php?type=events&amp;session=<?= urlencode($s['id']) ?>">events</a>
          </td>
        </tr>
        <?php endforeach; ?>
      </table>
    </div>
    <?php endif; ?>
  </section>

  <!-- Keep in step with report.php. -->
  <details class="card">
    <summary><strong>What the CSV columns mean</strong></summary>
    <h2 style="margin-top: 14px">Summary CSV — one row per participant and device</h2>
    <p class="muted">Every device that has the client or the app open is recorded, each in its own row. The participant's television is the row whose <code>device_type</code> is the TV: <code>android_apk</code> (Philips with the reference client app), <code>samsung_tizen</code>, <code>lg_webos</code> or <code>hbbtv_tv</code>. A <code>browser</code> row is a laptop or phone that had the page open at the time — ignore it.</p>
    <table>
      <tr><td><code>watched_seconds</code></td><td>Time the TV was showing the client. Time in the background, and silences over 40 s (TV off, network down), are not counted.</td></tr>
      <tr><td><code>button_presses</code></td><td>Every key the participant pressed that the client or the signer app handles.</td></tr>
      <tr><td><code>presses_without_effect</code></td><td>Presses that changed nothing: signer already at the edge or at its smallest/largest size, an arrow in a split view, or OK.</td></tr>
      <tr><td><code>seconds_to_first_press</code></td><td>From Start session to the first press.</td></tr>
      <tr><td><code>times_channel_changed</code>, <code>times_subtitles_switched</code>, <code>times_signer_switched</code>, <code>times_view_changed</code>, <code>times_moved</code>, <code>times_resized</code></td><td>How often each was done. Switched = turned on or off.</td></tr>
      <tr><td><code>at_end_…</code></td><td>The setting when the session ended. Empty if it did not exist then (e.g. no signer on that channel).</td></tr>
      <tr><td><code>seconds_channel_N</code></td><td>Time on channel N.</td></tr>
      <tr><td><code>seconds_subtitles_on/off</code></td><td>Time with subtitles on or off.</td></tr>
      <tr><td><code>seconds_signer_on/off</code></td><td>Time on the signer channels (3–5) with the signer shown or hidden.</td></tr>
      <tr><td><code>seconds_view_…</code></td><td>Time in each view while the signer was shown: <code>floating_transparent</code> (Prosojno ozadje), <code>floating_grey</code> (Sivo ozadje), <code>split_overlapping</code> (Tolmač čez sliko), <code>split_side_by_side</code> (Tolmač ob sliki).</td></tr>
      <tr><td><code>seconds_position_…</code></td><td>Time at each place on screen (top-left … bottom-right), floating views only.</td></tr>
      <tr><td><code>seconds_signer_size_Npct</code></td><td>Time with the signer N % of the screen width wide, in any view.</td></tr>
    </table>
    <h2 style="margin-top: 18px">Events CSV — one row per thing that happened</h2>
    <p class="muted">Each row has the time, <code>from</code> (<code>tv</code> = the DVB-I client, <code>signer_app</code> = the signer application on channels 3–5), the <code>action</code>, the <code>key</code> pressed if any, and every setting after it.</p>
    <table>
      <tr><td>By the participant</td><td><code>channel_changed</code>, <code>subtitles_on/off</code>, <code>signer_on/off</code>, <code>signer_smaller/larger</code>, <code>view_changed</code>, <code>signer_moved</code></td></tr>
      <tr><td>Pressed, nothing changed</td><td><code>size_limit_reached</code>, <code>move_limit_reached</code>, <code>move_not_possible_in_split_view</code>, <code>ok_pressed</code></td></tr>
      <tr><td>By the TV itself</td><td><code>page_loaded</code>, <code>auto_tuned</code> (channel 1 after loading), <code>app_opened</code> (signer app started on channels 3–5), <code>still_watching</code> (every 30 s), <code>left_app</code> (HOME or another app), <code>returned_to_app</code>, <code>restart_received</code></td></tr>
    </table>
  </details>

<script>
(function () {
  var el = document.getElementById('tv');
  if (!el) return;
  function poll() {
    var xhr = new XMLHttpRequest();
    xhr.open('GET', 'index.php?status=1');
    xhr.onload = function () {
      try { var s = JSON.parse(xhr.responseText); } catch (e) { return; }
      if (!s.lastReceived) {
        el.className = 'warn';
        el.textContent = 'Television: no report in this session yet (it reloads within a few seconds of a reset).';
        return;
      }
      var ago = Math.round((s.now - s.lastReceived) / 1000);
      el.className = ago < 45 ? 'ok' : 'warn';
      el.textContent = 'Television: last report ' + ago + ' s ago (' + s.lastAction + ')' +
        (ago < 45 ? '' : ' — is it on, and in the foreground?');
    };
    xhr.send();
  }
  poll();
  setInterval(poll, 3000);
})();
</script>
<?php endif; ?>
</main>
</body>
</html>
