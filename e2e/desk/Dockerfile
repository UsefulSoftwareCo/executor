# The Desk: a virtual Linux desktop that e2e scenarios are FILMED on — one
# Xvfb display showing a real terminal window (the chat) and a real headed
# Chromium (the browser hop), captured by a single ffmpeg x11grab into one
# session.mp4. No splicing: the film is the screen.
#
# The repo is bind-mounted at /repo at runtime; node_modules and caches live
# in named volumes (host artifacts are macOS-native and can't be reused).
FROM node:22-bookworm

RUN apt-get update && apt-get install -y --no-install-recommends \
    xvfb openbox xterm ffmpeg xdotool x11-utils x11-xserver-utils \
    fonts-dejavu-core fonts-noto-color-emoji \
    curl unzip ca-certificates git \
  && rm -rf /var/lib/apt/lists/*

# Bun — the repo's package manager and script runner.
RUN curl -fsSL https://bun.sh/install | bash -s "bun-v1.3.13" \
  && ln -s /root/.bun/bin/bun /usr/local/bin/bun \
  && ln -s /root/.bun/bin/bun /usr/local/bin/bunx

# Chromium + system deps baked into the image, pinned to the repo's
# playwright version so the runtime install check is a no-op.
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
RUN npx -y playwright@1.60.0 install --with-deps chromium && rm -rf /root/.npm

WORKDIR /repo
ENTRYPOINT ["bash", "e2e/desk/entry.sh"]
