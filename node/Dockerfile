FROM node:18-alpine

WORKDIR /app

# Copy package files
COPY package*.json ./

# Install dependencies
RUN npm install

# Copy application files
COPY . .

# Create uploads directory
RUN mkdir -p uploads

# Expose ports (HTTP and P2P)
EXPOSE 5001 5002 5003 6001 6002 6003

# Start the node
CMD ["node", "server.js"]