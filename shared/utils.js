const { Duration } = require('luxon')
const path = require('path')
const prompt = require('syncprompt')

function appendPath (strPath, str) {
  if (!strPath) {
    return strPath
  }
  const { dir, base } = path.parse(strPath)
  let pos = base.indexOf('.')
  if (pos < 0) {
    pos = base.length
  }
  return path.join(dir, base.slice(0, pos) + str + base.slice(pos))
}

function copyAttributes (obj, attrs) {
  return attrs.reduce((ret, key) => {
    ret[key] = obj[key]
    return ret
  }, {})
}

function deepFreeze (obj, levels = -1) {
  // Do we have an array? If so, freeze each element
  if (Array.isArray(obj)) {
    obj = [...obj]
    for (let idx = 0; idx < obj.length; idx++) {
      const ele = obj[idx]
      if (typeof ele === 'object' && ele !== null) {
        obj[idx] = deepFreeze(ele, (levels > 0) ? levels - 1 : levels)
      }
    }
    return Object.freeze(obj)
  }

  // Handle objects with properties
  obj = {...obj}
  if (levels !== 0) {
    // Retrieve the property names defined on obj
    var propNames = Object.getOwnPropertyNames(obj)

    // Freeze properties before freezing self
    propNames.forEach((name) => {
      const prop = obj[name]
      if (typeof prop === 'object' && prop !== null) {
        obj[name] = deepFreeze(prop, (levels > 0) ? levels - 1 : levels)
      }
    })
  }
  return Object.freeze(obj)
}

function promptYesNo (question, defaultChoice = 'yes') {
  const valid = { 'yes': true, 'y': true, 'no': false, 'n': false }

  let strPrompt = ' [y/n] '
  if (defaultChoice === 'yes') {
    strPrompt = ' [Y/n] '
  } else if (defaultChoice === 'no') {
    strPrompt = ' [y/N] '
  } else if (defaultChoice) {
    throw new Error('Invalid defaultChoice: ' + defaultChoice)
  }

  while (true) {
    const choice = prompt(question + strPrompt).toLowerCase()
    if (defaultChoice && choice === '') {
      return valid[defaultChoice]
    } else if (choice in valid) {
      return valid[choice]
    } else {
      console.log(`Please respond with 'yes' or 'no' (or 'y' or 'n').`)
    }
  }
}

function parseDurationISO8601 (text) {
  const arr = text.split(':')
  if (arr.length <= 0 || arr.length > 4) {
    return Duration.invalid('unparsable')
  }
  const mult = [ 24, 60, 60, 1000 ]
  const secs = arr.pop()
  if (secs.includes('.')) {
    mult.push(1)
    const subarr = secs.split('.')
    if (subarr.length !== 2) {
      return Duration.invalid('unparsable')
    }
    arr.push(...subarr)
  } else {
    arr.push(secs)
  }
  let val = 0
  let base = 1
  while (arr.length > 0) {
    base *= mult.pop()
    const num = parseInt(arr.pop())
    if (Number.isNaN(num) || (mult.length > 0 && num >= mult[mult.length - 1])) {
      return Duration.invalid('unparsable')
    }
    val += num * base
  }
  return Duration.fromMillis(val)
}

function randomDuration (range) {
  const [min, max] = Array.isArray(range) ? range : [range, range]
  return Duration.fromMillis(randomInt(...[min, max].map(x => parseDurationISO8601(x).valueOf())))
}

function randomInt (min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min
}

function truthy (val) {
  const truthyValues = { 'true': 1, '1': 1, 'yes': 1, 'y': 1 }
  return val && val.toString().toLowerCase() in truthyValues
}

module.exports = {
  appendPath,
  copyAttributes,
  deepFreeze,
  promptYesNo,
  randomDuration,
  randomInt,
  truthy
}
