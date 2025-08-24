# Use Node.js 18 base image
FROM node:18

# Set app directory
WORKDIR /usr/src/app

# Install dependencies
COPY package*.json ./
RUN npm install --production

# Copy all files
COPY . .

# Cloud Run expects the app on port 8080
EXPOSE 8080
CMD ["node", "server.js"]
