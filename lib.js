// @format
const core = require("@actions/core");
const fetch = require("cross-fetch");
const isPortReachable = require("is-port-reachable");
const process = require("process");
const { hrtime } = process;

const config = require("./config.js");

// TODO: Move within each function
const options = {
  server: {
    name: core.getInput("server-name"),
    image: core.getInput("server-image"),
    type: core.getInput("server-type")
  },
  sshKeyName: core.getInput("ssh-key-name"),
  hcloudToken: core.getInput("hcloud-token"),
  timeout: core.getInput("startup-timeout")
};

async function periodicRequest(port, host, timeout) {
  return new Promise(async res => {
    const start = hrtime.bigint();
    let online;
    // NOTE: hrtime.bigint() is in nano seconds, which is 1e-6 apart from milli
    // seconds
    while (Number(hrtime.bigint() - start) / (1000 * 1000) < timeout) {
      online = await isPortReachable(port, {
        host
      });
      if (online) {
        break;
      }
      await new Promise(resolve => setTimeout(resolve, 1000));
    }

    return res(online);
  });
}

async function deploy() {
  let res;
  try {
    res = await fetch(`${config.API}/servers`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${options.hcloudToken}`,
        "User-Agent": config.USER_AGENT
      },
      body: JSON.stringify({
        name: options.server.name,
        image: options.server.image,
        server_type: options.server.type,
        ssh_keys: [options.sshKeyName]
      })
    });
  } catch (err) {
    core.setFailed(err.message);
  }

  if (res.status === 201) {
    console.log("Hetzner Cloud Server deployment successful");
    const body = await res.json();
    // NOTE: We set the SERVER_ID optimistically as we definitely want to still
    // delete the server if our periodic request fails.
    const ipv4 = body.server.public_net.ipv4.ip;
    core.exportVariable("SERVER_ID", body.server.id);
    core.exportVariable("SERVER_IPV4", ipv4);

    const online = await periodicRequest(
      config.DEFAULT_PORT,
      ipv4,
      options.timeout
    );

    if (online) {
      return res;
    } else {
      core.setFailed(
        `Waited ${
          options.timeout
        }ms for server to come online, but it never came online.`
      );
    }
  } else {
    core.setFailed(
      `When sending the request to Hetzner's API, an error occurred "${
        res.statusText
      }"`
    );
  }
}

async function clean() {
  const deleteServer = core.getInput("delete-server") === "true";
  if (!deleteServer) {
    console.log("Aborted post cleaning procedure with delete-server: false");
    return;
  }

  let res;
  const URI = `${config.API}/servers/${process.env.SERVER_ID}`;
  try {
    res = await fetch(URI, {
      method: "DELETE",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${options.hcloudToken}`,
        "User-Agent": config.USER_AGENT
      }
    });
  } catch (err) {
    core.setFailed(err.message);
  }

  if (res.status === 200) {
    console.log("Hetzner Cloud Server deleted in clean up routine");
    return res;
  } else {
    core.setFailed(
      `When sending the request to Hetzner's API, an error occurred "${
        res.statusText
      }"`
    );
    return;
  }
}

async function assignIP() {
  const floatingIPId = core.getInput("floating-ip-id");

  if (typeof floatingIPId !== "number") {
    core.setFailed(
      `Not assigning server a floating IP as "floating-ip-id" input has wrong type of wasn't declared. Actual type: "${typeof floatingIPId}"`
    );
    return;
  }

  let res;
  const URI = `${config.API}/floating_ips/${floatingIPId}/actions/assign`;
  const { SERVER_ID } = process.env;
  try {
    res = await fetch(URI, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${options.hcloudToken}`,
        "User-Agent": config.USER_AGENT
      },
      body: JSON.stringify({ server: SERVER_ID })
    });
  } catch (err) {
    core.setFailed(err.message);
  }

  if (res.status === 201) {
    console.log(
      `Floating IP with ID "${floatingIPId}" was assigned to server with id: "${SERVER_ID}"`
    );
    return res;
  } else {
    core.setFailed(
      `When assigning a floating ip to the server an error occurred "${
        res.statusText
      }"`
    );
    return;
  }
}

module.exports = {
  deploy,
  clean,
  periodicRequest,
  assignIP
};
