# Containerised on purpose: this template exists to prove the deployment
# contract works for a service, not only for a static bundle.
FROM node:24-slim
WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev
COPY . .
ENV PORT=8080
EXPOSE 8080
CMD ["npm", "start"]
