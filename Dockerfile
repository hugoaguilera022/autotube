FROM python:3.12-alpine3.19
RUN apk add --no-cache git xvfb nss freetype freetype-dev harfbuzz ca-certificates ttf-freefont chromium chromium-chromedriver
WORKDIR /app
RUN git clone --depth 1 https://github.com/imputnet/yt-session-generator.git /app/session
WORKDIR /app/session
RUN pip install --no-cache-dir -r requirements.txt
RUN sed -i 's/await self.sleep(0.5)/await self.sleep(2)/' /usr/local/lib/python3.12/site-packages/nodriver/core/browser.py
EXPOSE 8080
CMD ["sh","-c","Xvfb :99 -ac -screen 0 1280x720x16 -nolisten tcp >/tmp/xvfb.log 2>&1 & sleep 2; DISPLAY=:99 python potoken-generator.py --bind 0.0.0.0 --port 8080"]
