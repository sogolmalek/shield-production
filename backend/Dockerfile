FROM node:20-slim
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm install --production
COPY server.js goldrush.js ./
EXPOSE 3001
CMD ["node", "server.js"]
