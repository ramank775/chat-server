FROM node:22-alpine

ARG NODE_ENV=production
ENV NODE_ENV $NODE_ENV

WORKDIR /app

COPY package*.json /app

RUN npm ci --ignore-scripts

COPY . /app/
