#!/bin/sh

if [ -z ${SSH_PORT+x} ]; then echo "please export SSH_PORT to be configured on raspberry pi before using the script"; exit 1; else echo "raspberry pi will be configured to use port '$SSH_PORT' for ssh"; fi

# assuming ubuntu server 20.04.3 LTS image
# be aware ubuntu requires manual ssh login with initial passwd change
export RASPI_HOSTNAME=ubuntu
export RASPI_USER=ubuntu
export SSH_PORT=58736

# get ip
RASPI_IP=$(ping $RASPI_HOSTNAME -n 1 | grep -E "Antwort von (.*?):" | sed -r 's/Antwort von (.*?):.*/\1/g')

# transfer pub key to raspi
scp $RASPI_PUB_KEY $RASPI_USER@$RASPI_HOSTNAME:/home/$RASPI_USER/public_keyfile

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
touch .ssh/authorized_keys
cat public_keyfile > .ssh/authorized_keys
rm public_keyfile

sudo cp /etc/ssh/sshd_config /etc/ssh/sshd_config.bak

sudo sed -i 's/^PasswordAuthentication yes/PasswordAuthentication no/g' /etc/ssh/sshd_config

sudo sed -i 's/^#Port 22/Port $SSH_PORT/g' /etc/ssh/sshd_config

sudo service ssh restart
ENDSSH
