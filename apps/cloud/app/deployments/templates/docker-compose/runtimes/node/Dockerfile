# Seeded because the project's technical plan describes a Node service.
#
# This file belongs to you. PromptWorkspace wrote it once at repository creation and
# never overwrites it — grow it into whatever this application actually needs.
FROM node:24-slim
WORKDIR /app
COPY package.json ./
# `npm install`, not `npm ci`: the seeded scaffold ships no lockfile, and the
# first implementation task is expected to commit one.
RUN npm install --omit=dev
COPY . .
ENV PORT=8080
EXPOSE 8080
CMD ["npm", "start"]
