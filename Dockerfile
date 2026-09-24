FROM public.ecr.aws/docker/library/node:22-alpine

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY server.js ./
COPY data/*.js ./data/
COPY public ./public

USER 501:20
EXPOSE 3000
CMD ["node", "server.js"]
