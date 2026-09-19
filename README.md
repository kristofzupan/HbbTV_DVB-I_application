# HbbTV / DVB-I accessibility app

Master's thesis project. HbbTV app with sign language interpreter overlay + subtitles, served via a DVB-I service list.

## Run it locally

Needs PHP (`brew install php` on mac).

```
node scripts/start-dvbi-reference-client.js
```

This patches the install location into the reference client's config/service list and starts `php -S`.

Open:

```
http://localhost:9080/frontend/android/player.html
```

Optional `.env` in repo root to change host/port:

```
BASE_URL=http://<your-ip>:9080
PORT=9080
```

If `DVB-I-Reference-Client/stream/loop/loop.json` doesn't exist yet, the stream segments aren't built. Build them with:

```
sh ffmpeg_stream_commands/prerender
sh ffmpeg_stream_commands/package-loop
```

(prerender takes a few minutes, only needed once or when source video changes)

## Deploying / updating a host

```
sh deploy/update
```

Pulls latest, re-applies the host's own address, rebuilds the stream if needed, restarts the publisher service.
