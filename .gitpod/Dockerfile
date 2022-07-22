FROM gitpod/workspace-mongodb

ENV NATS_VERSION="v2.8.3"
ENV KAFKA_VERSION="3.2.0"

COPY .gitpod/load.nginx.conf /etc/nginx/nginx.conf

RUN sudo apt-get update && sudo apt-get install redis-server -y

RUN wget https://downloads.apache.org/kafka/${KAFKA_VERSION}/kafka_2.13-${KAFKA_VERSION}.tgz  && \
  tar xzf kafka_2.13-${KAFKA_VERSION}.tgz && \
  sudo mv kafka_2.13-${KAFKA_VERSION} /kafka && \
  rm kafka_2.13-${KAFKA_VERSION}.tgz

RUN curl -L https://github.com/nats-io/nats-server/releases/download/${NATS_VERSION}/nats-server-${NATS_VERSION}-linux-amd64.zip -o nats-server.zip && \
  unzip nats-server.zip -d nats-server && \
  sudo cp nats-server/nats-server-${NATS_VERSION}-linux-amd64/nats-server /usr/bin && \
  rm -rf nats-server.zip nats-server
