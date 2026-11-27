# HbbTV interpreter app

HbbTV app that shows the sign language interpreter over the TV picture, with subtitles. The DVB-I client starts it from the service list (`backend/servicelists/thesis.xml`); on a TV it is signalled through the XML AIT (`aitx.php`).

How to run it locally and on the server is in the root README.

## Files

- `index.html`, `css/style.css` – UI, laid out at 960 px wide
- `js/app.js` – overlay position and size, views, subtitles, remote keys, sync with the main picture
- `js/hbbtv-bridge.js` – HbbTV objects (application manager, video/broadcast)
- `js/wasm-decoder.js` – interpreter decoding in WebAssembly (Broadway), the default
- `js/webcodecs-decoder.js` – interpreter decoding with WebCodecs
- `js/test-session.js` – user test logging, see `/test`
- `subtitles/main_slv.xml` – EBU-TT-D subtitles, built from `main_slv.srt` with `scripts/srt-to-ebu-tt-d.js`
- `wrapper.html` – entry page for the Samsung (Tizen) app

## URL parameters

- `interpreter=<mpd>` – interpreter stream
- `main=<mpd>` – main stream, only when the app plays the main picture itself

## Remote

- red – interpreter on/off
- arrows – move
- green / yellow – smaller / bigger
- blue – view
- TEXT – subtitles
