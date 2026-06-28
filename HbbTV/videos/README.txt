Place your video files here for reliable playback:

  main.mp4        – Main content (TV programme, etc.)
  interpreter.mp4 – Sign language interpreter (same or separate recording)

Then from the project root run a local server:

  python3 -m http.server 8080

and open:  http://localhost:8080

Opening index.html directly (file://) often blocks video; use a local server.
