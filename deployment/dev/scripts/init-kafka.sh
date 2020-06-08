#!/bin/sh

start_zookeeper() {
    bin/zookeeper-server-start.sh config/zookeeper.properties
}

start_kafka_server() {
    bin/kafka-server-start.sh config/server.properties
}


create_topic() {
    bin/kafka-topics.sh --create --zookeeper $ZOOKER_ENDPOINT --replication-factor 1 --partitions 1  --topic $1
}

list_topics() {
    bin/kafka-topics.sh --list --zookeeper $ZOOKER_ENDPOINT
}

CURR_DIR=`pwd`;

KAFKA_HOME=${KAFKA_HOME:'kafka'};

cd $KAFKA_HOME;

start_zookeeper;

sleep 30s;

start_kafka_server;

sleep 30s;

for var in "${!TOPIC_@}"; do
    create_topic $var;
    sleep 1s;
done

list_topics;

cd $CURR_DIR
