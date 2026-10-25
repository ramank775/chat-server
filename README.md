# Chat Server
[![Contributor Covenant](https://img.shields.io/badge/Contributor%20Covenant-2.1-4baaaa.svg)](code_of_conduct.md)

A chat server based on the microservice architecture to ensure high availability, high throughput, horizontal scalability.

## Architecture
![Architecture](docs/Architecture.png)

### Components
- Nginx: Nginx act as API gateway as well as load balancer.
    - Responsibility
        - API Gateway
        - Authentication
        - Load Balancing
  
- Web Socket Edge Gateway: It's handling client websocket connection and sending message to message broker
    - Responsibility
        - Maintaining Web Socket Connection
        - Forwarding `new-message` event to message broker
        - Updated user connection state
        - Sending message back to client

- Chat MS: It provides functioanlity like send and fetching message via http endpoint, provide auth token for edge gateway.
    - Responsibility
        - Send Message to message broker.
        - Fetch undelivered message to user.
        - Provide auth token for edge gateway

- Profile MS: Rest Api Service provides functionality like `login`, `auth`, `contact-sync` 
    - Responsibility
        - Login, Auth
        - Contact Sync

- Channel MS: Rest Api Service provides functionality to `create`, `update` channels (Previously unkown as Group MS)
    - Responsibility
        - Create Group
        - Add, Remove Members
        - Fetch groups

- Message Delivery Worker: Message delivery in real time when the user is connected, send offline message when user is not connected
    - Responsibility
       - Message push in real time when a user in connected.
       - Store message when the user is disconnected.
       - Guaranteed message delivery to the receiver.
       - Ability to sync message in background.
  
- Push Notification: Deliver message to user when user is offline
    - Responsibility
        - Deliver message to offline user

## Directory Structure

| Name |  Description |
| ---- |  ----------- |
| .github | Configuration files related to github like workflows, funding |
| .husky | git hooks configuration via [husky](https://typicode.github.io/husky) |
| deployment | Deployment scripts |
| docs | Docs related to the project |
| helper | Common utility functions |
| libs | Project specific libs like base class for microservice, resource configuration and initialization |
| services | Microservice |
| .env.tmpl | Environment template file |
| LICENSE | Project License file (MIT) |
| package.json | Node project configuration file |
| README.md | Project description and other details |

## How to setup

### Development environment on local machine

### Prerequisites
- [Apache Kafka](https://kafka.apache.org/) / [Nats](https://nats.io/)
- Mongodb
- Nginx
- Redis

### Steps
- Clone the master branch of the project
- Install dependencies

    ``` 
    npm install 
    ```
    Or 
    ``` 
    yarn install 
    ```
- Make copy of `.env.tmpl` to `.env` and update the required variables
    ```
    cp .env.tmpl .env
    ```
- Initialize Message Broker 
    ```
    cd deployment/scripts
    ```
    Setup Kafka
    ```
    ./init-kafka.bash ${KAFKA_INSTALLATION_DIRECTORY} .env
    ```
    OR

    Setup Nats
    ```
    ./init-nats.bash .env
    ```

- Open project in vscode
- Start the required microservice from `RUN and DEBUG` option
- (Optional) Start nginx using the configuration [deployment/config/nginx.config](./deployment/config/nginx.dev.config)




## Deployment
For deployment guide refer to [deployment/README.md](./deployment/README.md).

# Resources

## API specs doc 
[![Run in Postman](https://run.pstmn.io/button.svg)](https://god.gw.postman.com/run-collection/20439391-376454b4-ccc4-4fb5-8b88-5a3a3392e6d1?action=collection%2Ffork&collection-url=entityId%3D20439391-376454b4-ccc4-4fb5-8b88-5a3a3392e6d1%26entityType%3Dcollection%26workspaceId%3Def561179-c2db-47e5-85ce-10440f20555c)

- API documentation [here](https://documenter.getpostman.com/view/20439391/Uyr5neME)

- Open API specs 3.0 [here](./docs/openapi.yaml)

## Blog posts
To follow the update keep a eye on vartalap blogs on [blog.one9x.org](https://blog.one9x.org)
Some of the relevent blogs are:
- [Vartalap: Open Source Personal Messaging App](https://blog.one9x.org/vartalap/2021/04/04/vartalap-personal-messaging-app.html)
- [Vartalap: Chat Server Architecture V1](https://blog.one9x.org/vartalap/2021/04/10/vartalap-chat-server-architecture.html)
- [Vartalap: Chat Server Architecture V2](https://blog.one9x.org/vartalap/2021/05/22/vartalap-chat-server-architecture-v2.html)
- [Vartalap: Chat Server Architecture V2.1](https://blog.one9x.org/vartalap/2021/06/26/vartalap-chat-server-architecture-v2-1.html)


## LICENSE
 [MIT](./LICENSE)
