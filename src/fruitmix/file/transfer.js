import path from 'path'
import fs from 'fs'
import child from 'child_process'
import EventEmitter from 'events'

import xattr from 'fs-xattr'
import UUID from 'node-uuid'

import E from '../lib/error'
import config from '../cluster/config'

const isFruitmix = (uuid) => {
  
}

class Worker extends EventEmitter {

  constructor() {
    super()
    this.finished = false
    this.state = 'PADDING'
    this.id = UUID.v4()
    this.userUUID = ''
  }

  cleanUp() {
  }

  finalize() {
    this.cleanUp() 
    this.finished = true
  }

  error(e, ...args) {
    this.emit('error', e, ...args)
    this.finalize()
  }

  finish(data, ...args) {
    this.emit('finish', data, ...args)
    this.finalize()
  }

  start() {
    if (this.finished) throw 'worker already finished'
    this.run()
  }

  abort() {
    if (this.finished) throw 'worker already finished'
    this.emit('error', new E.EABORT())
    this.finalize()
  }

  isRunning() {
    return this.state === 'RUNNING'
  }

  isPadding() {
    return this.state === 'PADDING'
  }

}

/**
 * state:
 * PADDING
 * RUNNING
 * FINISHED
 * WARNING
 */

class Move extends Worker {
  constructor(src, dst, data, userUUID) {
    super()
    this.src = src
    this.dst = dst
    this.data = data
    this.userUUID = userUUID
  }

  cleanUp() {

  }

  run() {
    if(this.state !== 'PADDING') return 
    this.state = 'RUNNING'
    let srcType = src.type === 'fruitmix'
    let dstType = dst.type === 'fruitmix'
    let modeType = srcType && dstType ? 'FF' : srcType && !dstType ?
                    'FE' : !srcType && dstType ? 'EF' : 'EE'
    switch(modeType){
      case 'FF':
      case 'FE':
        this.copy(err => {
          if(this.finished) return 
          if(err) return this.error(err)
          this.delete(err => {
            if(this.finished) return 
            if(err) return this.error(err)

            let srcNode = this.data.findNodeByUUID(path.basename(this.src))
            let dstNode = this.data.findNodeByUUID(path.basename(this.dst))
            if(srcNode)
              this.data.requestProbeByUUID(srcNode.parent)
            if(dstNode)
              this.data.requestProbeByUUID(dstNode.uuid)

            return this.finish(this)//TODO probe
          })
        })
        break
      case 'EF':
        this.cleanXattr(err => {
          if(this.finished) return 
          if(err) return this.error(err)
          this.move(err => {
            if(this.finished) return 
            if(err) return this.error(err)

            let dstNode = this.data.findNodeByUUID(path.basename(this.dst.path))
            if(dstNode)
              this.data.requestProbeByUUID(dstNode.uuid)
            return this.finish(this)
          })
        })
        break
      case 'EE':
        this.move(err => {
          if(this.finished) return 
          if(err) return this.error(err)
          return this.finish(this)
        })
    }
  }

  copy(callback) {
    // let srcpath = this.src.type === 'fruitmix' ? this.data.findNodeByUUID(path.basename(this.src.path)) : 
    // TODO to join ext path Jack
    child.exec(`cp -r --reflink=auto ${ this.src } ${ this.dst }`,(err, stdout, stderr) => {
      if(err) return callback(err)
      if(stderr) return callback(stderr)
      return callback(null, stdout)
    })
  }

  delete(callback) {
    // TODO  join Path Jack
    child.exec(`rm -rf ${ this.src }`, (err, stdout, stderr) => {
      if(err) return callback(err)
      if(stderr) return callback(stderr)
      return callback(null, stdout)
    })
  }

  // visitor tree dump xattr
  cleanXattr(callback){
    const clean = (dir, dirContext, entry, callback) => {
      let xattrType = dirContext.type
      let fpath = path.join(dir, entry)
      xattr.setSync(fpath, xattrType, JSON.stringify({}))
      fs.lstatSync(fpath).isFile() ? callback() : callback(dirContext)
    }
    this.visit(this.src, { type: 'user.fruitmix'}, clean, callback)
  }

  move(callback){
    child.exec(`mv -f ${ this.src } ${ this.dst }`, (err, stdout, stderr) => {
      if(err) return callback(err)
      if(stderr) return callback(stderr)
      return callback(null, stdout)
    })
  }

  visit(dir, dirContext, func, done) { 
    fs.readdir(dir, (err, entries) => {
      if (err || entries.length === 0) return done()
      
      let count = entries.length
      entries.forEach(entry => {

        func(dir, dirContext, entry, (entryContext) => {
          if (entryContext) {
            visit(path.join(dir, entry), entryContext, func, () => {
              count--
              if (count === 0) done()
            })
          }
          else {
            count --
            if (count === 0) done()
          }
        })
      })
    })
  }

}

class Copy extends Worker {
  constructor(src, dst, tmp, data, userUUID) {
    super()
    this.src = src
    this.dst = dst
    this.tmp = tmp
    this.data = data
    this.userUUID = userUUID
  }

  cleanUp() {

  }

  run() {
    if(this.state !== 'PADDING') return 
    this.state = 'RUNNING'
    let srcType = isFruitmix(this.src)
    let dstType = isFruitmix(this.dst)

    //check src.type .path

    let modeType = srcType && dstType ? 'FF' : srcType && !dstType ?
                    'FE' : !srcType && dstType ? 'EF' : 'EE'
    // switch(modeType){
    //   case 'FF':
    //   case 'EF'://probe
    //     break
    //   case 'FE':
    //   case 'EE':
    //     break
    // }
    this.copy(err => {
      if(this.finished) return 
      if(err) return  this.error(err)
      fs.rename(this.tmp, this.dst, err => {
        if(this.finished) return 
        if(err) return  this.error(err)
        if(modeType === 'FF') {
          let srcNode = this.data.findNodeByUUID(path.basename(this.src))
          let dstNode = this.data.findNodeByUUID(path.basename(this.dst))
          if(srcNode)
            this.data.requestProbeByUUID(srcNode.parent)
          if(dstNode)
            this.data.requestProbeByUUID(dstNode.uuid)
        } //probe src dst
        if(modeType === 'EF') {
          let dstNode = this.data.findNodeByUUID(path.basename(this.dst))
          if(dstNode)
            this.data.requestProbeByUUID(dstNode.uuid)
        }//probe dst
        return this.finish(this)
      })
    })
  }

  copy(callback) {
    child.exec(`cp -r --reflink=auto ${ this.src } ${ this.tmp }`,(err, stdout, stderr) => {
      if(err) return callback(err)
      if(stderr) return callback(stderr)
      return callback(null, stdout)
    })
  }

}


class Transfer {
  constructor(data) {
    this.workersQueue = []
    this.warningQueue = []
    this.limit = 1
    this.data = data
  }

  schedule() {
    let diff = this.limit - this.workersQueue.filter(worker => worker.isRunning()).length
    if (diff <= 0) return

    this.workersQueue.filter(worker => !worker.isRunning())
      .slice(0, diff)
      .forEach(worker => worker.start())
  }
  
  createMove({ src, dst, userUUID }, callback) {
    createMoveWorker(src, dst, this.data, userUUID, (err, worker) => {
      if(err) return callback(ett)
      worker.on('finish', worker => {
        worker.state = 'FINISHED'
        this.schedule()
      })
      worker.on('error', worker => {
        worker.state = 'WARNING'
        this.workersQueue.splice(this.workersQueue.indexOf(worker), 1)
        this.warningQueue.push(worker)
        this.schedule()
      })
      this.workersQueue.push(worker)
      callback(null, worker)
      this.schedule()
    })
  }

  createCopy({ src, dst, userUUID }, callback) {
    createCopyWorker(src, dst, this.data, userUUID, (err, worker) => {
      if(err) return callback(err)
      worker.on('finish', worker => {
        worker.state = 'FINISHED'
        this.schedule()
      })
      worker.on('error', worker => {
        worker.state = 'WARNING'
        this.workersQueue.splice(this.workersQueue.indexOf(worker), 1)
        this.warningQueue.push(worker)
        this.schedule()
      })
      this.workersQueue.push(worker)
      this.schedule()
      callback(null, worker)
    })
  }

  getWorkers (userUUID , callback) {
    let data = this.workersQueue.filter(worker => worker.userUUID === userUUID)
    process.nextTick(() => callback(null, data))
  }

  abortWorker ({ userUUID , workerId }, callback){
    let worker = this.workersQueue.find((worker => worker.id === workerId && worker.userUUID === userUUID))
    if(worker){
      try{
        worker.abort()
        process.nextTick(() => callback(null, true))
      }catch(e){
        process.nextTick(() => callback(e))
      }
    }else{
      process.nextTick(() => callback(new E.EABORT()))
    }
  }

  register(ipc){
    ipc.register('createMove', this.createMove.bind(this)) 
    ipc.register('createCopy', this.createCopy.bind(this))
    ipc.register('getWorkers', this.getWorkers.bind(this))
    ipc.register('abortWorker', this.abortWorker.bind(this))
  }
}


const createMoveWorker = (src, dst, data, userUUID, callback) => {
  if(fs.existsSync(src) && fs.existsSync(dst)) {
    let worker = new Move(src, dst, data)
    return callback(null, worker)
  }
  return callback(new Error('path not exists'))
}

const createCopyWorker = (src, dst, data, userUUID, callback) => {
  let tmp = path.join(config.path, 'tmp') //TODO Get tmp folder Jack
  if(fs.existsSync(src) && fs.existsSync(dst)) {
    let worker = new Copy(src, dst, tmp, data)
    return callback(null, worker)
  }
  return callback(new Error('path not exists'))
}

export default Transfer