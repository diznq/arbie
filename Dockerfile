FROM node:12-alpine

WORKDIR /app
COPY package.json /app/package.json

RUN npm install

COPY src /app/src
COPY static/index.html /app/static/index.html
COPY state.json /app/state.json
COPY env.json /app/env.json

EXPOSE 8000
CMD node src/index.js