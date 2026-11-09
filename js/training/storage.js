// training/storage.js
// Posts a finished recording to the local Node server, which
// writes training-data/<LABEL>/<LABEL>_NNN.json.

(function () {

  function saveTrainingSample(sample) {

    fetch("/api/training/sample", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(sample)
    }).then(function (response) {
      return response.json().then(function (body) {
        if (!response.ok) {
          throw new Error(
            (body && body.message) || "Save failed."
          );
        }

        console.log(
          "Saved training sample:",
          body.path
        );
      });
    }).catch(function (err) {
      console.error(
        "Could not save the training sample into training-data.",
        "The app has to be running with node server/index.js.",
        err
      );
    });
  }

  window.saveTrainingSample =
    saveTrainingSample;

})();
