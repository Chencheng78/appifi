const rimraf = require('rimraf')
const fs = require('fs')

const UUID = require('uuid')
const debug = require('debug')('xdir')

const XNode = require('./xnode')
const XFile = require('./xfile')

class State {
  constructor(ctx, ...args) {
    this.ctx = ctx
    this.ctx.state = this
    this.destroyed = false
    this.enter(...args)

    let state = this.constructor.name
    debug(`${this.ctx.src.name || '[root]'} entered ${state}`)
    this.ctx.ctx.reqSched()

    this.ctx.emit('StateEntered', state)
  }

  enter() { }
  exit() { }

  getState() {
    return this.constructor.name
  }

  setState(NextState, ...args) {
    this.exit()
    new NextState(this.ctx, ...args)
  }

  destroy() {
    this.destroyed = true
    this.exit()
  }

  policyUpdated() {
  }

  view() {
  }
}

/**
Making target directory

Entering this state when user try to resolve name conflict by single or global policy
*/
class Mkdir extends State {
  enter() {
    let policy = this.ctx.getPolicy()
    let [same, diff] = policy
    let type = this.ctx.ctx.type
    if (same === 'keep') same = 'skip'

    this.mkdir([same, diff], (err, dst, resolved) => {
      if (this.destroyed) return
      if (err && err.code === 'EEXIST') return this.setState(Conflict, err, policy)
      if (err) return this.setState(Failed, err)
      // 文件夹操作成功，根据操作类型及策略进行后续操作

      // skip 策略， 直接进入完成状态
      if ((policy[0] === 'skip' && resolved[0])
        || (policy[1] === 'skip' && resolved[1])) return this.setState(Finish)

      // 移动操作，在冲突情况下，除了keep策略，其他策略完成后直接进入完成状态
      if (type === 'move') {
        if (policy[0] !== 'keep') return this.setState(Finish)
        else if (!resolved[0]) return this.setState(Finish)
      }

      // 其他策略情况下，文件夹node进入preparing状态
      this.ctx.dst = { uuid: dst.uuid, name: dst.name }
      this.setState(Preparing)
      
    })
  }

  /**
  */
  mkdir(policy, callback) {
    if (this.ctx.ctx.type === 'copy') {
      let name = this.ctx.src.name
      let props = {
        driveUUID: this.ctx.ctx.dst.drive,
        dirUUID: this.ctx.parent.dst.uuid,
        names: [name],
        policy
      }

      this.ctx.ctx.vfs.MKDIRS(this.ctx.ctx.user, props, (err, map) => {
        if (err) {
          callback(err)
        } else {
          let { err, stat, resolved } = map.get(name)
          callback(err, stat, resolved)
        }
      })
    } else if (this.ctx.ctx.type === 'move') {
      try {
        let name = this.ctx.src.name
        let names = [name]
        let src = { drive: this.ctx.ctx.src.drive, dir: this.ctx.parent.src.uuid }
        let dst = { drive: this.ctx.ctx.dst.drive, dir: this.ctx.parent.dst.uuid }
        this.ctx.ctx.vfs.MVDIRS(this.ctx.ctx.user, { src, dst, names, policy }, (err, map) => {
          if (err) callback(err)
          else {
            let { err, stat, resolved } = map.get(name)
            callback(err, stat, resolved)
          }
        })
      } catch (err) {
        debug(err)
        callback(err)
      }
    } else {
      let err = new Error('not implemented yet')
      err.status = 500
      callback(err)
    }
  }
}

/**
`Conflict` state for directory sub-task

@memberof XCopy.Dir
@extends XCopy.State
*/
class Conflict extends State {
  enter(err, policy) {
    this.err = err
    this.policy = policy
  }

  view() {
    return {
      error: {
        code: this.err.code,
        xcode: this.err.xcode
      },
      policy: this.policy
    }
  }

  policyUpdated() {
    this.setState(Mkdir)
  }
}

/**
Preparing state has target dir ready.

1. read source dir entries
2. make corresponding target dir in batch mode
3. pass fstats, dstats (decorated) to parent if any
4. or go to finish state
*/
class Preparing extends State {
  enter() {
    this.ctx.readdir((err, stats) => {
      if (err) {
        debug(err.message)
        this.setState(Failed)
      } else {
        let fstats = []
        let dstats = []

        // root node 需要筛选子任务
        if (this.ctx.parent === null) {
          this.ctx.ctx.entries.forEach(entry => {
            let stat = stats.find(x => x.name === entry)
            if (stat) {
              if (stat.type === 'directory') {
                dstats.push(stat)
              } else {
                fstats.push(stat)
              }
            } else {
              // TODO
            }
            
          })
        } else {
          fstats = stats.filter(x => x.type === 'file')
          dstats = stats.filter(x => x.type === 'directory')
        }

        if (dstats.length === 0 && fstats.length === 0) { // no sub tasks
          this.setState(Finish)
        } else if (dstats.length === 0) { // only sub-file tasks
          this.setState(Parent, dstats, fstats)
        } else { // 存在文件夹子任务， 先创建文件夹，根据结果进行后续操作
          let boundF 
          let names = dstats.map(x => x.name)
          let type = this.ctx.ctx.type
          let policy = this.ctx.getGlobalPolicy()
          if (type === 'copy' || type === 'import') {
            boundF = this.ctx.mkdirs.bind(this.ctx)
          } else if (type === 'move') {
            boundF = this.ctx.mvdirs.bind(this.ctx)
          } else if (type === 'export') {
            boundF = this.ctx.mkdirs.bind(this.ctx)
          }

          boundF(names, (err, map) => {
            if (err) {
              debug('xdir mkdirs/mvdirs failed', err, names)
              // TODO
              this.setState(Failed, err)
            } else {
              dstats.forEach(x => x.dst = map.get(x.name))
              
              // 剔除 policy 为 skip 的文件夹
              let dstats2 = dstats.filter(x => {
                if (x.dst.resolved && x.dst.resolved[0] && policy[0] === 'skip') return false
                if (x.dst.resolved && x.dst.resolved[1] && policy[1] === 'skip') return false
                return (x.dst.err && x.dst.err.code === 'EEXIST') || !x.dst.err
              })

              // 对于move操作, 只有失败、keep策略生效两种情况下会继续
              if (type === 'move') {
                dstats2 = dstats2.filter(x => {
                  let conflictStation = x.dst.err && x.dst.err.code === 'EEXIST'
                  let keepStation = x.dst.resolved && x.dst.resolved[0] && policy[0] === 'keep'
                  return conflictStation || keepStation
                })
                console.log('in dir preparing & dstats length is ' + dstats2.length + ' & fstats length is ' + fstats.length)
              }

              if (dstats2.length === 0 && fstats.length === 0) this.setState(Finish)
              else this.setState(Parent, dstats2, fstats)
              
            }
          })
        }
      }
    })
  }

  view() {
    return {
      hello: 'world'
    }
  }
}

class Parent extends State {
  /**
  dstat {
    dst: { err, stat, resolved }diff
  }
  */
  enter(dstats, fstats) {
    this.ctx.dstats = dstats.filter(x => !x.dst.err)
    this.ctx.fstats = fstats
    // console.log(dstats)
    // console.log(fstats)
    // 创建失败文件夹 在sche之前创建
    dstats
      .filter(x => x.dst.err)
      .forEach(x => {
        let dir = new XDir(this.ctx.ctx, this.ctx, { uuid: x.uuid, name: x.name }, x.dst.err)
        dir.on('StateEntered', state => {
          if (state === 'Failed' || state === 'Finish') {
            dir.destroy()
            if (this.ctx.children.length === 0
              && this.ctx.dstats.length === 0
              && this.ctx.fstats.length === 0) this.ctx.setState(Finish)
          }
        })
      })
  }

  view() {
    return {
      state: 'Parent'
    }
  }
}

/**
`Failed` state for directory sub-task

@memberof XCopy.Dir
@extends XCopy.State
*/
class Failed extends State {
  // when directory enter failed
  // all descendant node are destroyed (but not removed)
  enter(err) {
    debug('xdir enter failed state', err)
    this.err = err
  }

  view() {
    return {
      error: {
        code: this.err.code,
        message: this.err.message
      }
    }
  }
}

/**
`Finished` state for directory sub-task

@memberof XCopy.Dir
@extends XCopy.State
*/
class Finish extends State {
  enter() {

    /**
    // let p = ['keep', 'skip']
    // delete the dir which is keep or skip in DirMove
    if (this.ctx.constructor.name === 'DirMove') {
      // && (p.includes(this.ctx.policy[0]) || p.includes(this.ctx.ctx.policies.dir[0]))) {
      let dirveUUID = this.ctx.ctx.srcDriveUUID
      let dir = this.ctx.ctx.ctx.vfs.getDriveDirSync(dirveUUID, this.ctx.src.uuid)
      let dirPath = this.ctx.ctx.ctx.vfs.absolutePath(dir)
      if (this.ctx.parent) {
        try {
          let files = fs.readdirSync(dirPath)
          if (!files.length) rimraf.sync(dirPath)
        } catch (e) {
          if (e.code !== 'ENOENT') throw e
        }
      }
    }

*/
  }
}

/**
The base class of sub-task for directory.

*/
class XDir extends XNode {
  /**

  creating a xdir @ preparing with src, dst, and optional entries
  creating a xdir @ conflicting with src, err, policy

  @param {object} ctx - task container
  @param {Dir} parent - parent dir node
  @param {object} src - source object
  @param {string} src.uuid - required, as the identifier of this sub task.
  @param {string} src.name - required
  @parma {object} dst - destination object
  @param {string} dst.name - required
  */
  constructor(ctx, parent, src, dst, entries) {
    super(ctx, parent)
    this.children = []
    this.src = src

    // 失败任务处理
    if (dst instanceof Error) {
      let err = dst
      let policy = entries
      new Conflict(this, err, policy)
    } else {
      this.dst = dst
      new Preparing(this, entries)
    }
  }

  get type() {
    return 'directory'
  }

  destroy() {
    let children = [...this.children]
    children.forEach(c => c.destroy())
    super.destroy()
  }

  getPolicy() {
    return [
      this.policy[0] || this.ctx.policies.dir[0] || null,
      this.policy[1] || this.ctx.policies.dir[1] || null
    ]
  }

  getGlobalPolicy() {
    return [
      this.ctx.policies.dir[0] || null,
      this.ctx.policies.dir[1] || null
    ]
  }

  updatePolicy(policy) {
    if (this.state.constructor.name !== 'Conflict') return
    this.policy[0] = policy[0] || this.policy[0]
    this.policy[1] = policy[1] || this.policy[1]
    this.state.policyUpdated()
  }

  policyUpdated(policy) {
    this.state.policyUpdated()
  }

  /**
  This function is used by scheduler

  @param {number} required
  @returns actual created
  */
  createSubDir(required) {
    if (required === 0) return 0
    if (this.state.constructor.name !== 'Parent') return 0
    if (!this.dstats || this.dstats.length === 0) return 0

    let arr = this.dstats.splice(0, required)
    arr.forEach(dstat => {
      let src = { uuid: dstat.uuid, name: dstat.name }
      let dst = { uuid: dstat.dst.stat.uuid, name: dstat.dst.stat.name }
      let dir = new XDir(this.ctx, this, src, dst)
      dir.on('StateEntered', state => {
        if (state === 'Failed' || state === 'Finish') {
          // children任务进入失败或或完成状态， 将任务从children中移除
          dir.destroy()
          if (this.children.length === 0 &&
            this.dstats.length === 0 &&
            this.fstats.length === 0) { this.setState(Finish) }
        }
      })
    })

    return arr.length
  }

  /**
  This function is used by scheduler

  @param {number} required
  @returns actual created
  */
  createSubFile(required) {
    if (required === 0) return 0
    if (this.state.constructor.name !== 'Parent') return 0
    if (!this.fstats || this.fstats.length === 0) return 0

    let arr = this.fstats.splice(0, required)
    arr.forEach(fstat => {
      let file = new XFile(this.ctx, this, { uuid: fstat.uuid || UUID.v4(), name: fstat.name })
      file.on('StateEntered', state => {
        if (state === 'Failed' || state === 'Finish') {
          file.destroy()
          if (this.children.length === 0 &&
            this.dstats.length === 0 &&
            this.fstats.length === 0) { this.setState(Finish) }
        }
      })
    })

    return arr.length
  }

  readdir(callback) {
    if (this.ctx.type === 'copy' || this.ctx.type === 'move' || this.ctx.type === 'export') {
      let props = {
        driveUUID: this.ctx.src.drive,
        dirUUID: this.src.uuid
      }
      this.ctx.vfs.READDIR(this.ctx.user, props, callback)
    } else if (this.ctx.type === 'import') {
      let props = {
        id: this.ctx.src.drive,
        path: this.namepath()
      }

      this.ctx.nfs.READDIR(this.ctx.user, props, callback)
    }
  }

  mkdirs(names, callback) {
    if (this.ctx.type === 'copy' || this.ctx.type === 'import') {
      let policy = this.getGlobalPolicy() // FIXME this should be global policy, not local one
      let [same, diff] = policy
      if (same === 'keep') same = 'skip'
      // console.log(`文件夹 ${this.src.name} 创建子文件夹策略 ${[same, diff]}`)
      let props = {
        driveUUID: this.ctx.dst.drive,
        dirUUID: this.dst.uuid,
        names,
        policy: [same, diff]
      }

      this.ctx.vfs.MKDIRS(this.ctx.user, props, callback)
    } else if (this.ctx.type === 'export') {
      let policy = this.getGlobalPolicy() // FIXME this shoudl be global policy
      let props = {
        id: this.ctx.dst.drive,
        path: this.dst.name,
        names,
        policy
      }
      this.ctx.nfs.MKDIRS(this.ctx.user, props, callback)
    }
  }

  mvdirs(names, callback) {
    let src = { drive: this.ctx.src.drive, dir: this.src.uuid }
    let dst = { drive: this.ctx.dst.drive, dir: this.dst.uuid }
    let policy = this.getGlobalPolicy()
    let [same, diff] = policy
    if (same === 'keep') same = 'skip'
    this.ctx.vfs.MVDIRS(this.ctx.user, { src, dst, names, policy: [same, diff] }, callback)
  }

}

module.exports = XDir
