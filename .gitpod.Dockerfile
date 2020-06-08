FROM gitpod/workspace-full

COPY config/nginx.conf /etc/nginx/nginx.conf

RUN wget https://downloads.apache.org/kafka/2.5.0/kafka_2.12-2.5.0.tgz  && \
    tar xzf kafka_2.12-2.5.0.tgz && \
    sudo mv kafka_2.12-2.5.0 /kafka && \
    rm kafka_2.12-2.5.0.tgz && \
    ls

ENV NGINX_DOCROOT_IN_REPO="www"
