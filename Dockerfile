FROM node:22-alpine AS build

WORKDIR /build
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

FROM node:22-alpine

LABEL org.opencontainers.image.source="https://github.com/Mia-Platform-Experiments/repo-access-sharer" \
      name="repo-access-sharer" \
      description="Gives a team access to the repositories created by the Mia-Platform Console (GitHub or GitLab)"

ENV NODE_ENV=production \
    HTTP_PORT=3000

WORKDIR /home/node/app
COPY --from=build /build/node_modules ./node_modules
COPY package.json index.js ./
COPY src ./src

# The Mia CI template checks this file exists in the image (COMMIT_SHA_FILEPATH).
ARG COMMIT_SHA=<not-specified>
RUN echo "repo-access-sharer: $COMMIT_SHA" > ./commit.sha

USER node
EXPOSE 3000
CMD ["node", "index.js"]
