FROM node:20-alpine
WORKDIR /app
RUN apk add --no-cache docker-cli
COPY package.json ./
RUN npm install --omit=dev
COPY server.js .
EXPOSE 8000
CMD ["node", "server.js"]

