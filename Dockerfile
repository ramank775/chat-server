FROM node:18-alpine3.14

WORKDIR /app

COPY package*.json /app

RUN npm ci

COPY . /app/
