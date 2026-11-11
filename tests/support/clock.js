export class Clock {
  now = 1_000_000;
  nextId = 0;
  tasks = new Map();

  setTimeout = (fn, delay) => this.add(fn, delay, false);
  setInterval = (fn, delay) => this.add(fn, delay, true);
  clearTimeout = (id) => this.tasks.delete(id);
  clearInterval = (id) => this.tasks.delete(id);

  add(fn, delay, repeat) {
    const id = ++this.nextId;
    this.tasks.set(id, { fn, at: this.now + delay, delay, repeat });
    return id;
  }

  async advance(ms) {
    const target = this.now + ms;
    for (let steps = 0; ; steps += 1) {
      if (steps > 10_000) throw new Error("Fake clock did not settle");
      const next = [...this.tasks].filter(([, t]) => t.at <= target).sort((a, b) => a[1].at - b[1].at)[0];
      if (!next) break;
      const [id, task] = next;
      this.now = task.at;
      if (task.repeat) task.at += task.delay;
      else this.tasks.delete(id);
      await task.fn();
    }
    this.now = target;
  }

  delays() {
    return [...this.tasks.values()].map((task) => task.at - this.now).sort((a, b) => a - b);
  }
}
