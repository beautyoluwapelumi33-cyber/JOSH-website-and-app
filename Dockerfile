FROM python:3-alpine
# The date keys the build cache so this layer installs today's OS fixes; AppJet keeps it current on deploy.
RUN echo "os-refresh 2026-11-13" && apk upgrade --no-cache
WORKDIR /app
COPY . .
ENV PORT=3000
EXPOSE 3000
# Static files served on all interfaces; honors the platform's $PORT.
CMD python3 -m http.server "$PORT" --bind 0.0.0.0
