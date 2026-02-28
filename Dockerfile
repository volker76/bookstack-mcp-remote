FROM node:20-alpine

# Install the bookstack MCP server globally so it's on PATH
RUN npm install -g bookstack-mcp-server

WORKDIR /app

COPY package.json .
RUN npm install --omit=dev

COPY src/ ./src/

EXPOSE 3100

CMD ["node", "src/server.js"]
