FROM node:24-slim
WORKDIR /app
COPY server.js package.json ./
ENV PORT=8080 DATA_DIR=/data
VOLUME /data
EXPOSE 8080
USER node
CMD ["node", "--no-warnings", "server.js"]
