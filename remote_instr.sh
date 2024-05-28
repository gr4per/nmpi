#!/bin/sh

if [ -z ${SSH_PORT+x} ]; then echo "please export SSH_PORT to be configured on raspberry pi before using the script"; exit 1; else echo "raspberry pi will be configured to use port '$SSH_PORT' for ssh"; fi
if [ -z ${RASPI_HOSTNAME+x} ]; then echo "please export RASPI_HOSTNAME to be configured on raspberry pi before using the script"; exit 1; else echo "raspberry pi will be connected via hoastname '$RASPI_HOSTNAME'"; fi

# assuming ubuntu server 20.04.3 LTS image
# be aware ubuntu requires manual ssh login with initial passwd change
export RASPI_USER=ubuntu

# get ip
RASPI_IP=$(ping $RASPI_HOSTNAME -n 1 | grep -E "Antwort von (.*?):" | sed -r 's/Antwort von (.*?):.*/\1/g')
echo "RASPI IP = "  $RASPI_IP

# connect 1st ssh
ssh $RASPI_USER@$RASPI_HOSTNAME << ENDSSH
cd ~
if [ -e .ssh ]
then
   echo ".ssh in place, skipping mkdir"
else
   echo ".ssh has to be created"
   mkdir .ssh
fi

sudo cp /etc/ssh/sshd_config /etc/ssh/sshd_config.bak

sudo sed -i 's/^PasswordAuthentication yes/PasswordAuthentication no/g' /etc/ssh/sshd_config

sudo sed -i 's/^#Port 22/Port $SSH_PORT/g' /etc/ssh/sshd_config

sudo service ssh restart
ENDSSH
