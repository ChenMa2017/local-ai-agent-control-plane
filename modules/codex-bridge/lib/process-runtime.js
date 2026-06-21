"use strict";

function createProcessRuntime(deps) {
  const {
    fsp,
    sleep,
    readTask,
    appendTaskLog,
    selfPid
  } = deps;

  function pidLooksAlive(pid) {
    const value = Number(pid);
    if (!Number.isInteger(value) || value <= 0) {
      return false;
    }
    try {
      process.kill(value, 0);
      return true;
    } catch (error) {
      return error && error.code === "EPERM";
    }
  }

  function processGroupLooksAlive(pgid) {
    const value = Number(pgid);
    if (!Number.isInteger(value) || value <= 0) {
      return false;
    }
    try {
      process.kill(-value, 0);
      return true;
    } catch (error) {
      return error && error.code === "EPERM";
    }
  }

  async function procCmdline(pid) {
    const value = Number(pid);
    if (!Number.isInteger(value) || value <= 0) {
      return "";
    }
    return fsp.readFile(`/proc/${value}/cmdline`, "utf8").then((text) => text.replace(/\0/g, " ")).catch(() => "");
  }

  async function taskWorkerLooksAlive(task) {
    if (!pidLooksAlive(task.pid)) {
      return false;
    }
    const cmdline = await procCmdline(task.pid);
    return cmdline.includes("__worker") && cmdline.includes(task.task_id);
  }

  function signalProcessGroup(pgid, signal) {
    const value = Number(pgid);
    if (!Number.isInteger(value) || value <= 0) {
      return false;
    }
    if (value === selfPid) {
      throw new Error("Refusing to signal the current process group.");
    }
    try {
      process.kill(-value, signal);
      return true;
    } catch (error) {
      if (error && error.code === "ESRCH") {
        return false;
      }
      if (error && error.code === "EPERM") {
        return true;
      }
      throw error;
    }
  }

  async function terminateTaskProcessGroup(config, task, reason) {
    const fresh = await readTask(config, task.task_id).catch(() => task);
    const pgid = Number(fresh.pgid || fresh.pid);
    const workerAlive = await taskWorkerLooksAlive(fresh);
    if (!workerAlive || !processGroupLooksAlive(pgid)) {
      await appendTaskLog(config, fresh, `${reason}: task process group is already gone`);
      return { signalled: false, signal: null };
    }

    await appendTaskLog(config, fresh, `${reason}: sending SIGTERM to pgid=${pgid}`);
    signalProcessGroup(pgid, "SIGTERM");
    const deadline = Date.now() + config.cancelGraceMs;
    while (Date.now() < deadline) {
      if (!processGroupLooksAlive(pgid)) {
        return { signalled: true, signal: "SIGTERM" };
      }
      await sleep(100);
    }

    if (processGroupLooksAlive(pgid)) {
      await appendTaskLog(config, fresh, `${reason}: sending SIGKILL to pgid=${pgid}`);
      signalProcessGroup(pgid, "SIGKILL");
      await sleep(200);
      return { signalled: true, signal: "SIGKILL" };
    }

    return { signalled: true, signal: "SIGTERM" };
  }

  return {
    pidLooksAlive,
    processGroupLooksAlive,
    procCmdline,
    taskWorkerLooksAlive,
    signalProcessGroup,
    terminateTaskProcessGroup
  };
}

module.exports = {
  createProcessRuntime
};
