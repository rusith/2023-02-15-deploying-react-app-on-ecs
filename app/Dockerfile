FROM node:18-alpine
EXPOSE 3000

RUN mkdir /app
WORKDIR /app

COPY . /app

RUN yarn install
ENV NODE_ENV=production

RUN yarn build
CMD ["yarn", "start"]