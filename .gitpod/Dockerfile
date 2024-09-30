FROM gitpod/workspace-mongodb

ARG NODE_VERSION="20"
ARG NATS_VERSION="v2.10.21"
ARG KAFKA_VERSION="3.8.0"
ARG NATS_CLI_VERSION="0.1.5"

COPY .gitpod/load.nginx.conf /etc/nginx/nginx.conf

RUN bash -c 'source $HOME/.nvm/nvm.sh && nvm install $NODE_VERSION \
    && nvm use $NODE_VERSION && nvm alias default $NODE_VERSION'

RUN sudo apt-get update && sudo apt-get install redis-server -y

RUN wget https://downloads.apache.org/kafka/${KAFKA_VERSION}/kafka_2.13-${KAFKA_VERSION}.tgz  && \
  tar xzf kafka_2.13-${KAFKA_VERSION}.tgz && \
  sudo mv kafka_2.13-${KAFKA_VERSION} /kafka && \
  rm kafka_2.13-${KAFKA_VERSION}.tgz

RUN curl -L https://github.com/nats-io/nats-server/releases/download/${NATS_VERSION}/nats-server-${NATS_VERSION}-linux-amd64.zip -o nats-server.zip && \
  unzip nats-server.zip -d nats-server && \
  sudo cp nats-server/nats-server-${NATS_VERSION}-linux-amd64/nats-server /usr/bin && \
  rm -rf nats-server.zip nats-server

RUN curl -L https://github.com/nats-io/natscli/releases/download/v${NATS_CLI_VERSION}/nats-${NATS_CLI_VERSION}-linux-amd64.zip -o nats-cli.zip && \
  unzip nats-cli.zip -d nats-cli && \
  sudo cp nats-cli/nats-${NATS_CLI_VERSION}-linux-amd64/nats /usr/bin && \
  rm -rf nats-cli.zip nats-cli
