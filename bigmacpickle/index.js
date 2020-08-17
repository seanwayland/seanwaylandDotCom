// Select the button

var vTL=2.5; var vTU=2.5; var vCL=95
var pickleRadius = 50
var biteR = 100
var lowerLimit ="0.00"
var upperLimit ="100.00"

function BinP(N,p,x1,x2) {
    var q=p/(1-p); var k=0; var v = 1; var s=0; var tot=0
    while(k<=N) {
        tot=tot+v
        if(k>=x1 & k<=x2) { s=s+v }
        if(tot>1e30){s=s/1e30; tot=tot/1e30; v=v/1e30}
        k=k+1; v=v*q*(N+1-k)/k
    }
    return s/tot
}


function Fmt(x) {
    var v
    if(x>=0) { v=''+(x+0.00005) } else { v=''+(x-0.00005) }
    return v.substring(0,v.indexOf('.')+5)
}

function CalculateBin(a,b) {
    var vx = eval(a)
    var vN = eval(b)
    var vP = vx/vN
    var probability = Fmt(vP)

    if(vx===0)
    { lowerLimit = "0.0000" } else
    { var v=vP/2; vsL=0; vsH=vP; var p=vTL/100
        while((vsH-vsL)>1e-5) { if(BinP(vN,v,vx,vN)>p) { vsH=v; v=(vsL+v)/2 } else { vsL=v; v=(v+vsH)/2 } }
        lowerLimit = Fmt(v) }
    if(vx===vN)
    { upperLimit = "1.0000" } else
    { var vv=(1+vP)/2; vsL=vP; vsH=1; var p=vTU/100
        while((vsH-vsL)>1e-5) { if(BinP(vN,vv,0,vx)<p) { vsH=vv; vv=(vsL+vv)/2 } else { vsL=vv; vv=(vv+vsH)/2 } }
        upperLimit = Fmt(vv) }



    return([probability, lowerLimit, upperLimit])
}

function runTrials(numberOfTrials){

    //var tbody = d3.select("tbody");

    vizSVG.selectAll("#pickle").remove()
    vizSVG.selectAll("#pickle2").remove()
    vizSVG.selectAll("#mouth").remove()

    vizSVG.append("svg:circle")
        .attr("id", "bigmac")
        .attr("cx", 300)
        .attr("cy", 300)
        .attr("r", 187.5 )
        .attr("fill", "yellow");


    let trialSuccesses = 0

    for (let i = 0; i < numberOfTrials; i++) {


        // (300,112.5)
        // radius of circle minus pickle
        // place the centre of the pickle at a random point within the big mac where possible
        let R = 137.5; // radius of big mac - radius of pickle.
        let c = {x: 300, y: 300};
        let a = Math.random() * 2 * Math.PI;// angle
        let r = Math.sqrt(~~(Math.random() * R * R));// distance from the center of the main circle
        // x and y coordinates of the particle
        let x = c.x + r * Math.cos(a);
        let y = c.y + r * Math.sin(a);

        vizSVG.append("svg:circle")
            .attr("id", "pickle")
            .attr("cx", x)
            .attr("cy", y)
            .attr("r", pickleRadius)
            .attr("fill", "green")

        ;

        let pickle1 = [x, y]

        let RR = 137.5; // radius of big mac - radius of pickle.
        let cc = {x: 300, y: 300};
        let aa = Math.random() * 2 * Math.PI;// angle
        let rr = Math.sqrt(~~(Math.random() * RR * RR));// distance from the center of the main circle
        // x and y coordinates of the particle
        let xx = cc.x + rr * Math.cos(aa);
        let yy = cc.y + rr * Math.sin(aa);

        vizSVG.append("svg:circle")
            .attr("id", "pickle2")
            .attr("cx", xx)
            .attr("cy", yy)
            .attr("r", pickleRadius)
            .attr("fill", "green")
        ;
        let pickle2 = [xx, yy]

        // max bite is cy of 487.5
        // min bite is cy of 447.5
        let biteDepth = Math.floor(Math.random() * 40);
        vizSVG.append("svg:circle")
            .attr("id", "mouth")
            .attr("cx", 300)
            .attr("cy", 447.5 + biteDepth)
            .attr("r", biteR)
            .attr("fill", "pink")
        ;

        let bite = [300, 447.5 + biteDepth]
        let bitThePickle = (DistBetweenPoints(bite, pickle1) < 150 || DistBetweenPoints(bite, pickle2) < 150)
        if (bitThePickle) {
            console.log("Bit the Pickle")
            trialSuccesses ++

        }

    }
    console.log("trial successes")
    console.log(trialSuccesses)
    console.log(numberOfTrials)
    console.log(CalculateBin(trialSuccesses,numberOfTrials))
    var results = CalculateBin(trialSuccesses,numberOfTrials)
    d3.select("#p>span").text(results[0]);
    d3.select("#l>span").text(results[1]);
    d3.select("#u>span").text(results[2]);
    d3.select("#b>span").text(trialSuccesses);


}




function DistBetweenPoints(p1, p2) {
    var a = p1[0] - p2[0];
    var b = p1[1] - p2[1];

    var c = Math.sqrt( a*a + b*b );

    return c
}
var button = d3.select("#trialsButton");

button.on("click", function() {

    console.log("button clicked")

    // Select the input element and get the raw HTML node
    var inputElement = d3.select("#runTrials");

    // Get the value property of the input element
    var inputValue = inputElement.property("value");

    console.log(inputValue);
    runTrials(inputValue)

    // Set the span tag in the h1 element to the text
    // that was entered in the form

});

var dropdown = d3.select('#selectButton')

dropdown.on("change", function(){
    var selectedOption = d3.select(this).property("value")
    console.log(selectedOption)
    if (selectedOption === "dots"){
        pickleRadius =2;
        biteR =2;
    }
    else {
        pickleRadius =50;
        biteR = 100;
    }


});

