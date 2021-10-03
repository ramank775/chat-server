#!/bin/bash

start_zookeeper() {
    bin/zookeeper-server-start.sh -daemon config/zookeeper.properties > /dev/null 2>&1 &
}

start_kafka_server() {
    bin/kafka-server-start.sh -daemon config/server.properties > /dev/null 2>&1 &
}


create_topic() {
    bin/kafka-topics.sh --create --bootstrap-server localhost:9092 --replication-factor 1 --partitions 1  --topic $1
}

list_topics() {
    bin/kafka-topics.sh --bootstrap-server localhost:9092 --list
}


KAFKA_HOME=${1:-/kafka};

echo "Kafka_Home" $KAFKA_HOME

ENV_FILE=${2:-.env}

echo "ENV FILE" $ENV_FILE

source $ENV_FILE

ZOOKER_ENDPOINT=${ZOOKER_ENDPOINT:-localhost:2181};

echo $ZOOKER_ENDPOINT

cd $KAFKA_HOME;

echo ${pwd}

start_zookeeper;

sleep 2s;

start_kafka_server;

sleep 2s;

for var in "${!TOPIC_@}"; do
    create_topic ${!var};
    sleep 1s;
done

list_topics;

