FROM node:24-alpine
WORKDIR /app
COPY dist/worker.js dist/wire.js ./
RUN printf '{"type":"module"}\n' > package.json
USER node
ENTRYPOINT ["node", "/app/worker.js"]
