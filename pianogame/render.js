"use strict";

/***
 * These functions and variables basically take care of the game play
 */
/**
 *start the synth used to play audio
 */
Synth instanceof AudioSynth; // start synth

var testInstance = new AudioSynth;
testInstance instanceof AudioSynth; // true

testInstance === Synth; // true


document.getElementById(keyNames[0]).style.fill = "white";
document.getElementById(keyNames[2]).style.fill = "white";
document.getElementById(keyNames[4]).style.fill = "white";
document.getElementById(keyNames[5]).style.fill = "white";
document.getElementById(keyNames[7]).style.fill = "white";
document.getElementById(keyNames[9]).style.fill = "white";
document.getElementById(keyNames[11]).style.fill = "white";

var melodyGuess = [];

function checkNote(note) {
    /***
     * every time a note is pressed it checks to see if it is correct and if the player has won
     *
     * @type {number}
     */
    // alert(notesinCode.length);

    var theNote = note - 12;
    melodyGuess.push(theNote);
    //alert(melodyGuess.toString());
    guessedNotes++;
    //alert(guessedNotes);
    //alert(melodyLength);
    // alert(melodyGuess.toString());
    //if (guessedNotes === Number(numberofNotes.value)) {
    if (guessedNotes == melodyLength) {  
       // alert("here") ;
        guessedNotes = 0;
        if (melodyGuess.length === secretMelody.length && melodyGuess.every(function (value, index) {
            return value === secretMelody[index]
        })) {

            alert("you guessed it ");
            //socket.emit('WinMsg', {amount: bet.value, user: vm.nickname, roomnum: vm.RoomNumber});
           // playerDolls.value2 = playerDolls.value2 - 2 * bet.value;
            document.getElementById("melody").disabled = false;
            document.getElementById("newCode").disabled = false;

        } else {
            guessedNotes = 0;
            melodyGuess = [];
            guessesLeft--;
            document.getElementById("melody").disabled = false;
            document.getElementById("newCode").disabled = false;
            alert("try again");
            }
        }
    }
    



/// function which changes the key of a clicked white key
function WhiteKeyClicked(id) {

    if (id > 11) {



        playNote(id);
        //checkNote(id);
        setTimeout(function () {
            checkNote(id);
        }, 1000);


        d3.select(document.getElementById(keyNames[id]))
            .transition()
            .duration(100)
            .style("fill", "green")

            .transition()
            .duration(100)
            .style("fill", "white")


    } else {

        if (keyChecked[id] == 0) {
            document.getElementById(keyNames[id]).style.fill = "yellow";
            keyChecked[id] = 1;
        } else {
            document.getElementById(keyNames[id]).style.fill = "white";
            keyChecked[id] = 0;
        }
    }


}

/// function which changes the key of a clicked black key
function BlackKeyClicked(id) {

    if (id > 11) {
        playNote(id);
        setTimeout(function () {
            checkNote(id);
        }, 1000);

        /// take a guess
        d3.select(document.getElementById(keyNames[id]))
            .transition()
            .duration(100)
            .style("fill", "green")

            .transition()
            .duration(100)
            .style("fill", "black")
    } else {

        if (keyChecked[id] == 0) {
            document.getElementById(keyNames[id]).style.fill = "yellow";
            keyChecked[id] = 1;
        } else {
            document.getElementById(keyNames[id]).style.fill = "black";
            keyChecked[id] = 0;
        }
    }

}
