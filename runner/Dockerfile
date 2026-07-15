# MINE Web Hands Runner — Computer Use sandbox
# Forks ideas from Anthropic's computer-use-demo quickstart
FROM ubuntu:22.04

ENV DEBIAN_FRONTEND=noninteractive \
    PYTHONUNBUFFERED=1 \
    DISPLAY=:1 \
    DISPLAY_NUM=1 \
    DISPLAY_WIDTH=1280 \
    DISPLAY_HEIGHT=800

# Install Xvfb (virtual display), Chrome, screenshot + input tools, Python
RUN apt-get update && apt-get install -y --no-install-recommends \
    xvfb x11vnc x11-apps \
    fluxbox xterm \
    xdotool scrot imagemagick \
    fonts-liberation libxshmfence1 \
    libnss3 libatk1.0-0 libatk-bridge2.0-0 libcups2 libdrm2 libxkbcommon0 \
    libxcomposite1 libxdamage1 libxfixes3 libxrandr2 libgbm1 libasound2 \
    libpango-1.0-0 libcairo2 libgtk-3-0 \
    wget curl ca-certificates gnupg \
    python3 python3-pip python3-tk \
 && rm -rf /var/lib/apt/lists/*

# Install Google Chrome
RUN wget -q -O - https://dl-ssl.google.com/linux/linux_signing_key.pub | apt-key add - \
 && echo "deb [arch=amd64] http://dl.google.com/linux/chrome/deb/ stable main" > /etc/apt/sources.list.d/google-chrome.list \
 && apt-get update && apt-get install -y google-chrome-stable \
 && rm -rf /var/lib/apt/lists/*

# Python deps
COPY requirements.txt /opt/runner/
RUN pip3 install --no-cache-dir -r /opt/runner/requirements.txt

# Runner code
COPY server.py            /opt/runner/
COPY computer_use_loop.py /opt/runner/
COPY tools/               /opt/runner/tools/
COPY start.sh             /opt/runner/

RUN chmod +x /opt/runner/start.sh

EXPOSE 8000

WORKDIR /opt/runner
ENTRYPOINT ["/opt/runner/start.sh"]
