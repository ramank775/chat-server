# Chat server deployment guide
 This directory contains the files, configurations and scripts.

## Setup
- Clone the repository using git.
  
  Note: for the docker based deployement instead of cloning the complete repository, use [sparse-checkout](https://www.git-scm.com/docs/git-sparse-checkout).

  To clone only the deployment directory.
  ``` bash
    # Create an empty directory on the server using 
    mkdir <dir-name>
    cd <dir-name>
    # Initialize git inside the directory
    git init

    # Enable sparse checkout
    git config core.sparseCheckout true

    # Add deployment directory path for checkout
    echo deployment >> .git/info/sparse-checkout

    # Add remote origin in local git repo
    git remote add -f origin https://www.github.com/ramank775/chat-server

    # Pull the files
    git pull origin master
  ```
- Create configuration/enviroment files
  - Create `.env` file from the sample `.env.tmpl` file.
  - Create `nginx.conf` file from the provided sample file based on the setup your are running at `config/nginx` directory.
  - Copy `service.json` file of firebase project at `config/firebase` directory.
  - Create `services.json` file from the provided sample file at `config/discovery_service`.
      Presently for service discovery of the `gateway server` a file based service discovery is used.
      For every gateway server add an entry in the `services.json` file 
      ```
      {
        [gateway-name-1]: 'http://endpoint-gateway-1:port'
        [gateway-name-2]: 'http://endpoint-gateway-2:port'
        ...
        [gateway-name-n]: 'http://endpoint-gateway-n:port'
      }
      ```
      Note: gateway name should be same as `--gateway-name=gateway-1` option supplied to start the gateway server.
  

### Docker based setup (Recommanded)

- Create `docker-compose.local.yml` file from `docker-compose.infra.yml` and change the neccesary options as per the requirement
- Start the services using `docker-compose -f docker-compose.yml -f docker-compose.local.yml up -d`
