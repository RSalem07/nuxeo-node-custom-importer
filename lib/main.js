var nuxeo = require('nuxeo'),
  path = require('path'),
  fs = require('fs'),
  rest = require('restler');

exports.import = function(config) {
  var client = new nuxeo.Client({
    baseURL: config.baseURL,
    username: config.username,
    password: config.password
  });

  var localPath = config.localPath;
  // TODO replace with path.isAbsolute() when switching to node 0.11.x
  if (localPath[0] !== '/') {
    localPath = path.join(process.cwd(), localPath);
  }

  if (fs.statSync(localPath).isFile()) {
    createFile(client, localPath, config.remotePath, createDocumentCallback);
    return;
  }

  // walk the whole directory tree
  var walk = function(localPath, remotePath) {
    fs.readdir(localPath, function(err, files) {
      files.forEach(function(file) {
        var absPath = path.join(localPath, file);
        if (fs.statSync(absPath).isDirectory()) {
          createFolder(absPath, remotePath, createFolderCallback)
        } else {
          createDocumentFromFile(absPath, remotePath, createDocumentCallback)
        }
      })
    })
  };
  walk(localPath, config.remotePath);

  var createDocumentFromFile = function(file, remotePath, callback) {
    var metadata = readFilename(path.basename(file), false);
    // Note type
    if (metadata.type === 'Note') {
      var content = fs.readFileSync(file, { encoding: 'UTF-8' });
      metadata.properties['note:note'] = content;
    }

    client.document(remotePath)
      .create({
        type: metadata.type,
        name: metadata.filename,
        properties: metadata.properties
    }, function(err, folder) {
      if (err) {
        callback(err, file, null, metadata);
      } else {
        callback(null, file, folder, metadata);
      }
    });
  };

  var createDocumentCallback = function(err, file, data, metadata) {
    if (err) {
      console.error('Error while creating file: ' + file);
      console.error(err);
      return;
    }

    if (config.verbose) {
      console.log('Created remote file: ' + data.path);
    }

    var doc = data;
    if (metadata.type !== 'Note') {
      // attach the Blob
      // Create the uploader bound to the operation
      var uploader = client.operation("Blob.Attach")
        .params({ document: doc.uid,
          save : true,
          xpath: "file:content"
        })
        .uploader();

      // Upload the file
      uploader.uploadFile(rest.file(file, null, fs.statSync(file).size, null, null), function(error, data) {
        if (error) {
          console.error('Error while uploading file: ' + file);
          console.error(err);
          return;
        }

        // When done, execute the operation
        uploader.execute(function(error, data) {
          if (error) {
            console.error('Error while attaching file: ' + file + ' to ' + doc.path);
            console.error(err);
            return;
          }

          // successfully attached blob
          if (config.verbose) {
            console.log('Attached blob to: ' + doc.path);
          }
        });
      });
    }

    setLifecycleState(data, metadata);
  };

  var createFolder = function(dir, remotePath, callback) {
    var metadata = readFilename(path.basename(dir), true);

    client.document(remotePath)
      .create({
        type: metadata.type,
        name: metadata.filename,
        properties: metadata.properties
    }, function(err, folder) {
      if (err) {
        callback(err, dir, null, metadata);
      } else {
        callback(null, dir, folder, metadata);
      }
    });
  };

  var createFolderCallback = function(err, dir, data, metadata) {
    if (err) {
      console.error('Error while creating folder: ' + dir);
      console.error(err);
      return;
    }

    if (config.verbose) {
      console.log('Created remote directory: ' + data.path);
    }

    setLifecycleState(data, metadata);

    walk(dir, data.path);
  };

  var setLifecycleState = function(data, metadata) {
    if (metadata.transition) {
      var operation = client.operation('Document.SetLifeCycle')
        .param('value', metadata.transition)
        .input(data.uid);

      operation.execute(function(err, doc, response) {
        if (err) {
          console.error('Error while following transition ' + metadata.transition + ' on doc ' + data.path);
          console.error(err);
          return;
        }

        if (config.verbose) {
          console.log('Followed transition  ' + metadata.transition + ' on doc ' + doc.path);
        }

        setACE(doc, metadata)
      });
    }
  };

  var setACE = function(data, metadata) {
    if (metadata.lifecycleState === 'obsolete') {
      var operation = client.operation('Document.SetACE')
        .param('user', 'quality')
        .param('permission', 'Read')
        .input(data.uid);

      operation.execute(function(err, doc, response) {
        if (err) {
          console.error('Error while setting Read ACE for "quality" group on doc ' + data.path);
          console.error(err);
          return;
        }

        if (config.verbose) {
          console.log('Setted Read ACE for "quality" group on doc ' + doc.path);
        }
      });
    }
  }
};

// Format: Type_source_lifecycestate_dc:valid_dc:creator_filename.doc
function readFilename(filename, isFolder) {
  var eles = filename.split('_');

  // when no Type defined, or only Type and filename
  var properties = {};
  if (eles.length === 1) {
    properties['dc:title'] = eles[0];
    return {
      type: isFolder? 'Folder' : 'File',
      filename: eles[0],
      properties: properties
    }
  } else if (eles.length === 2) {
    properties['dc:title'] = eles[1];
    return {
      type: eles[0],
      filename: eles[1],
      properties: properties
    }
  }

  // Wrong format
  if (eles.length < 6) {
    console.error('Wrong filename format: ' + filename);
    return null;
  }

  // compute the transition to follow
  var transition;
  switch(eles[2]) {
    case 'approved':
      transition = 'approve';
      break;
    case 'obsolete':
      transition = 'obsolete';
      break;
    case 'deleted':
      transition = 'delete';
      break;
  }

  // compute the default properties
  var properties = {};
  if (eles[3]) {
    properties['dc:valid'] = eles[3];
  }
  if (eles[4]) {
    properties['dc:creator'] = eles[4];
  }
  if (eles[1]) {
    properties['dc:source'] = eles[1];
  }
  properties['dc:title'] = eles[5];

  return {
    type: eles[0],
    lifecycleState: eles[2],
    transition: transition,
    properties: properties,
    filename: eles[5]
  }
}
