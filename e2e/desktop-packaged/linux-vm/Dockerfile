# Headless Linux box for reproducing the desktop daemon attach/spawn wedge
# against the REAL packaged app (no macOS, no Aqua, no host GUI). The linux
# bundle is built on the host (electron-builder --linux --arm64) and mounted at
# /app; this image only provides Xvfb plus Electron's runtime shared libraries
# and a Node to run the CDP repro driver.
FROM node:22-bookworm-slim

# Electron 41 runtime deps + Xvfb. Kept to the libs Chromium actually dlopen()s
# at startup so the image stays small and the failure surface is just "missing
# lib" (loud) rather than a silent renderer crash.
RUN apt-get update && apt-get install -y --no-install-recommends \
      xvfb xauth \
      libnss3 libnspr4 \
      libatk1.0-0 libatk-bridge2.0-0 libatspi2.0-0 \
      libgtk-3-0 libgbm1 libdrm2 \
      libxcomposite1 libxdamage1 libxfixes3 libxrandr2 libxkbcommon0 \
      libasound2 libcups2 libpango-1.0-0 libcairo2 \
      libx11-6 libxcb1 libxext6 libxi6 libxtst6 libglib2.0-0 \
      ca-certificates \
    && rm -rf /var/lib/apt/lists/*

COPY repro.mjs /repro/repro.mjs

# xvfb-run gives Chromium a virtual display; --no-sandbox is required because the
# container runs as root and we are not setuid-installing chrome-sandbox.
ENTRYPOINT ["xvfb-run", "-a", "-s", "-screen 0 1280x800x24", "node", "/repro/repro.mjs"]
