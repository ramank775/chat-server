FROM gitpod/workspace-mongodb

COPY deployment/dev/config/load.nginx.conf /etc/nginx/nginx.conf

RUN sudo apt-get update && sudo apt-get install redis-server -y

RUN wget https://downloads.apache.org/kafka/3.0.0/kafka_2.13-3.0.0.tgz  && \
    tar xzf kafka_2.13-3.0.0.tgz && \
    sudo mv kafka_2.13-3.0.0 /kafka && \
    rm kafka_2.13-3.0.0.tgz

ENV NGINX_DOCROOT_IN_REPO="www"
