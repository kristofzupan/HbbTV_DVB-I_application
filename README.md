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

(prerender takes about half an hour, most of it Film Bučko; only needed once or when source video changes. `sh ffmpeg_stream_commands/prerender napoved` rebuilds one channel: `tvmaribor`, `prenosniki`, `napoved`, `bucko`.)

Its inputs are `video_content/rtv_mb.mp4` and `video_content/urejeno/{prenosniki,napoved,bucko}/{main,tolmac}.mp4`, made by the scripts in `video_content/urejeno`.

`package-loop` also needs `video_content/source_normal.mp4`, the plain channel 1. It is built from a recording that is not in the repository, with `sh ffmpeg_stream_commands/prerender-normal` (about 10 minutes); on any other machine, copy the finished file into `video_content/`.

## Deploying / updating a host

```
sh deploy/update
```

Pulls latest, re-applies the host's own address, rebuilds the stream if needed, restarts the publisher service. Copy `video_content/source_*.mp4` (all five) to the host beforehand; their inputs are not in the repository, so they are not rebuilt there.
