# Use Node.js LTS version
FROM node:20-slim

# Create app directory
WORKDIR /usr/src/app

# Install app dependencies (including devDependencies for build)
COPY package*.json ./
RUN npm ci

# Bundle app source
COPY . .

# Build TypeScript
RUN npm run build

# Remove devDependencies for a smaller production image
RUN npm prune --production

# Expose the port the app runs on
EXPOSE 3000

# Set environment variables
ENV NODE_ENV=production

# Start the application
CMD ["npm", "start"] 