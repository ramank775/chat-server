FROM gitpod/workspace-full

RUN wget https://downloads.apache.org/kafka/2.5.0/kafka_2.12-2.5.0.tgz  && \
    tar xzf kafka_2.12-2.5.0.tgz && \
    mv kafka_2.12-2.5.0 /kafka && \
    rm kafka_2.12-2.5.0.tgz && \
    ls
