# Specify the base Docker image. You can read more about
# the available images at https://crawlee.dev/docs/guides/docker-images
# You can also use any other image with Node.js 16 or later.
FROM apify/actor-node-playwright-chrome:20

# Copy just package.json and package-lock.json
# to speed up the build using Docker layer caching.
COPY package*.json ./

# Install NPM packages, skip optional and development dependencies to
# keep the image small.
RUN npm --quiet install --include=dev --ignore-scripts

# Copy the rest of the source code.
COPY . ./

# Build the project.
RUN npm run build

# Run the image.
CMD [ "npm", "run", "start:prod" ]
