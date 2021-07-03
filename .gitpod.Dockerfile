FROM gitpod/workspace-mongodb

COPY deployment/dev/config/load.nginx.conf /etc/nginx/nginx.conf


RUN wget https://downloads.apache.org/kafka/2.8.0/kafka_2.13-2.8.0.tgz  && \
    tar xzf kafka_2.13-2.8.0.tgz && \
    sudo mv kafka_2.13-2.8.0 /kafka && \
    rm kafka_2.13-2.8.0.tgz && \
    ls

ENV NGINX_DOCROOT_IN_REPO="www"
